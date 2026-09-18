import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { DocumentTreeNode } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { SearchService } from '../search/search.service.js';
import { readFrontmatterRelations, readFrontmatterTags } from '../common/relations.js';
import { READ_TOOL_NAMES } from './assistant-tool-types.js';
import type { AssistantToolContext, AssistantToolResult } from './assistant-tool-types.js';

/** How much of a page one read_document call returns. */
const MAX_DOC_CHARS = 24_000;

/**
 * Ceiling on one list_document_tree answer.
 *
 * A whole workspace's tree is a lot of tokens to spend on orientation, and the
 * model can always look inside a section by passing its id. The response says
 * when the cap bit rather than reading as a complete tree.
 */
const MAX_TREE_NODES = 200;

/**
 * The five tools that only ever read.
 *
 * Split out of AssistantToolsService so the agent worker can run a tool loop.
 * That service injects DocumentRelationsService, MergeRequestsService,
 * StorageService and WebResearchService — all of which belong to the API
 * process — but none of those are touched by the read half, which needs only
 * search, documents, prisma and access. Every one of those is already
 * worker-loadable (SearchCoreModule, DocumentsCoreModule, PrismaModule,
 * AuthCoreModule), which is what makes this split possible at all.
 *
 * The write half stays where it is: a background agent proposes, and publishing
 * is the API's job (docs/features/17, "worker generates, API publishes").
 *
 * The name set itself is declared in the leaf beside the tool types, so the
 * harness can build its parallel-safe union without importing this service;
 * re-exported here because this is where the tools are implemented.
 */
export { READ_TOOL_NAMES };

@Injectable()
export class AssistantReadToolsService {
  private readonly logger = new Logger(AssistantReadToolsService.name);

  constructor(
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly documents: DocumentsService,
  ) {}

  definitions(): ChatCompletionFunctionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'list_document_tree',
          description:
            'Browse where pages actually sit in this workspace: the page tree, as flat rows carrying ' +
            'depth and childCount. Call it before creating a page, to pick the section it belongs under ' +
            'and pass that id as create_document\'s parentId. Also use it to check whether a page already ' +
            'exists somewhere before writing a second one. Start with no parentId for the top level, then ' +
            'pass the id of a section to look inside it.',
          parameters: {
            type: 'object',
            properties: {
              parentId: {
                type: 'string',
                description: 'Look inside this page. Omit for the top level of the tree.',
              },
              projectId: {
                type: 'string',
                description: 'Restrict to one project. Omit to span the whole workspace.',
              },
              depth: {
                type: 'integer',
                minimum: 1,
                maximum: 3,
                description: 'How many levels to expand; 2 when omitted.',
              },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_knowledge',
          description:
            'Hybrid (semantic + keyword) search over this workspace, with one hop of knowledge-graph ' +
            'expansion. Returns matching documents with snippets plus graph-related documents. ' +
            'Use it whenever the current page does not already answer the question.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural-language search query' },
              limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Max results (default 5)' },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_document',
          description:
            'Read the full markdown of one document in this workspace by its documentId ' +
            '(from search results, graph nodes, or the current page). Use it only for the most promising hits.',
          parameters: {
            type: 'object',
            properties: {
              documentId: { type: 'string', description: 'UUID of the document to read' },
            },
            required: ['documentId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'explore_document_graph',
          description:
            'The knowledge-graph neighbourhood of a document: related entities and the documents connected ' +
            'through them, with relation types and confidence. Use it to answer questions about how pages, ' +
            'systems, or concepts relate to each other.',
          parameters: {
            type: 'object',
            properties: {
              documentId: { type: 'string', description: 'UUID of the document to start from' },
              depth: { type: 'integer', minimum: 1, maximum: 2, description: 'Entity hops (default 1)' },
            },
            required: ['documentId'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'list_relations',
          description:
            'What a page is connected to: the relations it declares in its own frontmatter, its tags, and the ' +
            'edges the knowledge graph holds for it. Each graph edge names the class it came from — ' +
            '"frontmatter" (the page declares it), "explicit"/"curated" (a person added or confirmed it), or ' +
            '"inferred" (a model guessed it from the text, and nobody has confirmed it). Call this before ' +
            'proposing any relation change, so you are editing what the page actually declares rather than ' +
            'what the graph happens to hold.',
          parameters: {
            type: 'object',
            properties: {
              documentId: { type: 'string', description: 'UUID of the page' },
            },
            required: ['documentId'],
          },
        },
      },
    ];
  }

  /**
   * Runs one read tool.
   *
   * Authorises on every call rather than trusting the caller to have done it.
   * AssistantToolsService already checks before dispatching, so a chat turn pays
   * one extra indexed lookup per read — worth it, because the other caller is a
   * background agent with no guard in front of it, and a service that can be
   * driven from the worker must not depend on someone remembering.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    try {
      await this.access.requireRole(ctx.principal, ctx.workspaceId, 'viewer');
      switch (name) {
        case 'search_knowledge':
          return await this.searchKnowledge(args, ctx);
        case 'read_document':
          return await this.readDocument(args, ctx);
        case 'explore_document_graph':
          return await this.exploreGraph(args, ctx);
        case 'list_relations':
          return await this.listRelations(args, ctx);
        case 'list_document_tree':
          return await this.listDocumentTree(args, ctx);
        default:
          return this.fail(`Unknown tool ${name}`);
      }
    } catch (err) {
      // Includes ForbiddenException (revoked access mid-run) and Prisma errors
      // on malformed ids — the model gets a plain error, never a stack trace.
      this.logger.warn(`Tool ${name} rejected: ${err instanceof Error ? err.message : String(err)}`);
      return this.fail(err instanceof Error ? err.message : 'Tool execution failed');
    }
  }

  private async searchKnowledge(
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    const query = String(args.query ?? '')
      .slice(0, 2_000)
      .trim();
    if (!query) return this.fail('query is required');
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 5, 1), 10);

    const res = await this.search.search({
      workspaceId: ctx.workspaceId, // pinned — never from args
      query,
      mode: 'hybrid',
      limit,
      expandGraph: { depth: 1 },
    });
    // Where each hit lives, not just what it is called. Two pages both called
    // "Overview" in different sections were indistinguishable to the model,
    // which is how it ended up citing the wrong one and nesting new pages
    // beside it.
    const trails = await this.documents.breadcrumbsFor(
      ctx.workspaceId,
      res.results.map((r) => r.documentId),
    );
    const results = res.results.map((r) => ({
      documentId: r.documentId,
      title: r.title,
      breadcrumb: trails.get(r.documentId) || '(top level)',
      snippet: r.snippet,
    }));
    const related = (res.related ?? []).map((d) => ({
      documentId: d.documentId,
      title: d.title,
      via: d.via.map((v) => `${v.relationType} ${v.entityKey}`).slice(0, 5),
    }));
    return {
      content: JSON.stringify({ results, related }),
      ok: true,
      sources: res.results.map((r) => ({ documentId: r.documentId, title: r.title, snippet: r.snippet })),
    };
  }

  private async readDocument(
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    const documentId = String(args.documentId ?? '');
    const doc = await this.requireWorkspaceDocument(documentId, ctx);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);
    try {
      const content = await this.documents.getContent(documentId);
      const trails = await this.documents.breadcrumbsFor(ctx.workspaceId, [documentId]);
      return {
        content: JSON.stringify({
          documentId,
          title: doc.title,
          breadcrumb: trails.get(documentId) || '(top level)',
          markdown: content.markdown.slice(0, MAX_DOC_CHARS),
        }),
        ok: true,
        sources: [{ documentId, title: doc.title }],
      };
    } catch {
      return this.fail(`Document "${doc.title}" has no readable content yet (draft or unindexed)`);
    }
  }

  /**
   * The page tree, so placement can be a decision rather than a default.
   *
   * Until this existed the model could browse a connected git repository's
   * directory tree (`code_tree`) but not the knowledge base's own, and
   * `create_document`'s `parentId` asked for a UUID it had no way to discover.
   * Every AI-authored page therefore landed at the root of whichever project
   * happened to be oldest.
   *
   * Flat rows rather than nested JSON: `depth` carries the shape at a fraction
   * of the brackets, and the model reads it just as well.
   */
  private async listDocumentTree(
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    const depth = Math.min(Math.max(Math.floor(Number(args.depth)) || 2, 1), 3);
    const parentId = typeof args.parentId === 'string' && args.parentId ? args.parentId : undefined;
    const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined;

    const tree = await this.documents.getTree(ctx.workspaceId, projectId, {
      ...(parentId ? { parentId } : {}),
      depth,
    });

    const rows: Array<{
      documentId: string;
      title: string;
      depth: number;
      childCount: number;
      category: string;
    }> = [];
    let truncated = false;
    const walk = (nodes: DocumentTreeNode[], level: number): void => {
      for (const n of nodes) {
        if (rows.length >= MAX_TREE_NODES) {
          truncated = true;
          return;
        }
        rows.push({
          documentId: n.documentId,
          title: n.title,
          depth: level,
          childCount: n.childCount,
          category: n.category,
        });
        walk(n.children ?? [], level + 1);
      }
    };
    walk(tree.roots, 0);

    return {
      content: JSON.stringify({
        parentId: parentId ?? null,
        projectId: tree.projectId,
        nodes: rows,
        // Say when the cap bit, the way the workspace graph does, rather than
        // handing back a partial tree that reads as a complete one.
        ...(truncated
          ? { truncated: true, note: `Only the first ${MAX_TREE_NODES} nodes are listed. Pass parentId to look inside a section.` }
          : {}),
      }),
      ok: true,
      sources: [],
    };
  }

  private async exploreGraph(
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    const documentId = String(args.documentId ?? '');
    const depth = Math.min(Math.max(Math.floor(Number(args.depth)) || 1, 1), 2);
    const doc = await this.requireWorkspaceDocument(documentId, ctx);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);

    const graph = await this.documents.getDocumentGraph(documentId, depth);
    return {
      content: JSON.stringify({
        documentId,
        nodes: graph.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, distance: n.distance })),
        edges: graph.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence })),
      }),
      ok: true,
      sources: graph.nodes
        .filter((n) => n.kind === 'document' && n.id !== documentId)
        .slice(0, 8)
        .map((n) => ({ documentId: n.id, title: n.label })),
    };
  }

  /**
   * Declared relations and graph edges side by side (docs/features/28).
   *
   * Both halves matter and they routinely disagree: an `inferred` edge exists in
   * the graph while the page declares nothing, and that gap is exactly what a
   * model asked to tidy relations needs to see. Showing only one half would let
   * it "add" something already there, or miss what it was asked to confirm.
   */
  private async listRelations(
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    const documentId = String(args.documentId ?? '');
    const doc = await this.requireWorkspaceDocument(documentId, ctx);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);

    const { relations } = await this.documents.listRelations(documentId);
    // A draft or unindexed page has no readable content; its graph edges are
    // still worth reporting, so this degrades rather than failing.
    const content = await this.documents.getContent(documentId).catch(() => null);

    return {
      content: JSON.stringify({
        documentId,
        title: doc.title,
        declared: readFrontmatterRelations(content?.frontmatter).map((r) => ({
          type: r.type,
          targetKey: r.target.key,
          name: r.target.name,
        })),
        tags: readFrontmatterTags(content?.frontmatter),
        graph: relations.map((r) => ({
          type: r.type,
          targetKey: r.to.key,
          name: r.to.name,
          extractor: r.provenance.extractor,
          confidence: r.provenance.confidence,
        })),
      }),
      ok: true,
      sources: [{ documentId, title: doc.title }],
    };
  }

  /** Model-supplied ids are only honoured when the document lives in the pinned workspace. */
  private async requireWorkspaceDocument(documentId: string, ctx: AssistantToolContext) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) return null;
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true, title: true },
    });
    if (!doc || doc.workspaceId !== ctx.workspaceId) return null;
    return doc;
  }

  private fail(message: string): AssistantToolResult {
    return { content: JSON.stringify({ error: message }), ok: false, sources: [] };
  }
}
