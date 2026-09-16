import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { AccessService } from '../auth/access.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { SearchService } from '../search/search.service.js';
import { readFrontmatterRelations, readFrontmatterTags } from '../common/relations.js';
import type { AssistantToolContext, AssistantToolResult } from './assistant-tool-types.js';

/** How much of a page one read_document call returns. */
const MAX_DOC_CHARS = 24_000;

/**
 * The four tools that only ever read.
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
 */
export const READ_TOOL_NAMES = new Set([
  'search_knowledge',
  'read_document',
  'explore_document_graph',
  'list_relations',
]);

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
    const results = res.results.map((r) => ({
      documentId: r.documentId,
      title: r.title,
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
      return {
        content: JSON.stringify({
          documentId,
          title: doc.title,
          markdown: content.markdown.slice(0, MAX_DOC_CHARS),
        }),
        ok: true,
        sources: [{ documentId, title: doc.title }],
      };
    } catch {
      return this.fail(`Document "${doc.title}" has no readable content yet (draft or unindexed)`);
    }
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
