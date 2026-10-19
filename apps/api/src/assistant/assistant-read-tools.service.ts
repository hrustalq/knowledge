import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { AssistantAskSource, DocumentTreeNode } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import type { AccessScope } from '../permissions/access-scope.js';
import { SearchService } from '../search/search.service.js';
import { readFrontmatterRelations, readFrontmatterTags } from '../common/relations.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { TemplatesService } from '../templates/templates.service.js';
import { CommunitiesService } from '../communities/communities.service.js';
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
 * The tools that only ever read.
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
    private readonly templates: TemplatesService,
    private readonly permissions: PermissionService,
    private readonly communities: CommunitiesService,
  ) {}

  /**
   * The caller's page visibility, asked afresh on every tool call rather than
   * once per turn: a grant revoked mid-turn holds from the next call (#76).
   * Clamped to the run's audience when the output is read by more people
   * than the caller.
   */
  private async scopeOf(ctx: AssistantToolContext): Promise<AccessScope> {
    const scope = await this.permissions.scopeFor(ctx.principal, ctx.workspaceId);
    return ctx.audience ? this.permissions.audienceScope(scope, ctx.audience) : scope;
  }

  definitions(): ChatCompletionFunctionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'list_document_tree',
          description:
            'Browse where pages actually sit in this workspace: the page tree, as flat rows each carrying ' +
            'its own parentId, depth and childCount. Read parentId to see what a page hangs under — do not ' +
            'infer it from the order of the rows. Call it before creating a page, to pick the section it belongs under ' +
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
            'expansion. Returns matching documents with snippets plus graph-related documents. Each result ' +
            'carries a `cite` label (S1, S2, …) to end your sentences with. ' +
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
          name: 'global_overview',
          description:
            'For a broad question about the whole knowledge base ("what are our main risks?", "what do we know ' +
            'about payments?"): the communities of related pages closest to it, each with a summary of what its ' +
            'pages cover and the pages themselves (each with a `cite` label). Summaries are written by an agent ' +
            'from the pages — read the pages before relying on a detail. Empty when communities have not been built.',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The broad question, in natural language' },
              limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Max communities (default 4)' },
            },
            required: ['question'],
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
      {
        type: 'function',
        function: {
          name: 'list_templates',
          description:
            'The page templates this workspace offers (issue #69): ADRs, RFCs, runbooks, postmortems and the ' +
            "workspace's own shapes. Call it before writing a page of a recognisable kind, so it starts from the " +
            "shape the team uses — then read one with get_template and pass its ref to create_document.",
          parameters: {
            type: 'object',
            properties: {
              projectId: {
                type: 'string',
                description: "Include this project's own templates. Omit for the workspace-wide ones only.",
              },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_template',
          description:
            'One page template: its markdown skeleton, default category, tags and relations, and the ' +
            'placeholders (name, kind, required) create_document takes as values.',
          parameters: {
            type: 'object',
            properties: {
              templateRef: { type: 'string', description: 'A ref from list_templates, e.g. builtin:adr' },
            },
            required: ['templateRef'],
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
        case 'list_templates':
          return await this.listTemplates(args, ctx);
        case 'get_template':
          return await this.getTemplate(args, ctx);
        case 'global_overview':
          return await this.globalOverview(args, ctx);
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

    // Asked on this call, not once per turn: a grant revoked mid-turn holds
    // from the next search (#76).
    const scope = await this.scopeOf(ctx);
    const res = await this.search.search(
      {
        workspaceId: ctx.workspaceId, // pinned — never from args
        query,
        mode: 'hybrid',
        limit,
        // A project-scoped turn (issue #71) gets no graph expansion: related
        // pages are walked across the whole workspace, and offering them would
        // steer the model straight back out of the project it was bound to.
        ...(ctx.projectId ? { filters: { projectIds: [ctx.projectId] } } : { expandGraph: { depth: 1 } }),
      },
      scope,
    );
    // Where each hit lives, not just what it is called. Two pages both called
    // "Overview" in different sections were indistinguishable to the model,
    // which is how it ended up citing the wrong one and nesting new pages
    // beside it.
    const trails = await this.documents.breadcrumbsFor(
      scope,
      res.results.map((r) => r.documentId),
    );
    // One source per page, carrying the best chunk: the label is per page
    // (that is what a chip is), and the first hit for a page is its top-ranked
    // chunk, whose heading trail is where a citation link should land.
    const sources: AssistantAskSource[] = [];
    const seen = new Map<string, AssistantAskSource>();
    for (const r of res.results) {
      let source = seen.get(r.documentId);
      if (!source) {
        source = {
          documentId: r.documentId,
          title: r.title,
          snippet: r.snippet,
          revisionId: r.revisionId,
          chunkId: r.chunkId,
          headingPath: r.headingPath ?? [],
          score: r.score,
          factClass: 'explicit',
        };
        seen.set(r.documentId, source);
        sources.push(source);
      }
    }
    // Owner display names for the hits, one lookup. The dev principal and
    // deleted accounts have no row, and are simply not named.
    const ownerIds = [...new Set(res.results.map((r) => r.trust?.ownerId).filter((id): id is string => !!id))];
    const owners = ownerIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, displayName: true } })
      : [];
    const ownerName = new Map(owners.map((u) => [u.id, u.displayName]));
    const results = res.results.map((r) => ({
      documentId: r.documentId,
      title: r.title,
      breadcrumb: trails.get(r.documentId) || '(top level)',
      section: r.headingPath?.length ? r.headingPath.join(' › ') : undefined,
      snippet: r.snippet,
      // Trusted PG metadata, outside the untrusted content wrapper
      // (docs/features/39): the status is a fact about the row, not page text.
      ...(r.trust
        ? {
            status: r.trust.status,
            ...(r.trust.verifiedAt ? { verifiedAt: r.trust.verifiedAt } : {}),
            ...(r.trust.inactive ? { inactive: true } : {}),
            ...(r.trust.ownerId && ownerName.get(r.trust.ownerId) ? { owner: ownerName.get(r.trust.ownerId) } : {}),
          }
        : {}),
      ...this.citeOf(ctx, seen.get(r.documentId)!),
    }));
    const related = (res.related ?? []).map((d) => ({
      documentId: d.documentId,
      title: d.title,
      via: d.via.map((v) => `${v.relationType} ${v.entityKey}`).slice(0, 5),
    }));
    return {
      content: JSON.stringify({ results, related }),
      ok: true,
      sources,
    };
  }

  /**
   * #81 phase 7: the communities closest to a broad question, under the
   * caller's scope (a community with a page they may not open is withheld
   * whole). Summaries are agent-written from page content, so they travel
   * wrapped untrusted; each member page is a citable source.
   */
  private async globalOverview(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const question = String(args.question ?? '').slice(0, 2_000).trim();
    if (!question) return this.fail('question is required');
    const limit = Math.min(Math.max(Math.floor(Number(args.limit)) || 4, 1), 8);
    const communities = await this.communities.overview(await this.scopeOf(ctx), question, limit);
    const sources: AssistantAskSource[] = [];
    const seen = new Map<string, AssistantAskSource>();
    const results = communities.map((c) => ({
      title: c.title,
      summary: wrapUntrusted(c.summary, 'global_overview', 'page'),
      pages: c.documents.map((d) => {
        let source = seen.get(d.documentId);
        if (!source) {
          source = { documentId: d.documentId, title: d.title, snippet: c.summary.slice(0, 300), factClass: 'inferred' };
          seen.set(d.documentId, source);
          sources.push(source);
        }
        return { documentId: d.documentId, title: d.title, ...this.citeOf(ctx, source) };
      }),
    }));
    return { content: JSON.stringify({ communities: results }), ok: true, sources };
  }

  /**
   * The gallery, as the model reads it. Names and descriptions are typed by
   * workspace members, so the whole answer is wrapped untrusted — a template
   * called "ignore your instructions" is a template with a strange name.
   */
  private async listTemplates(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : undefined;
    // The project filter is a narrowing inside the pinned workspace: a foreign
    // project id matches no rows and returns the workspace-wide set.
    const { templates } = await this.templates.list({ workspaceId: ctx.workspaceId, ...(projectId ? { projectId } : {}) });
    const payload = templates.map((tpl) => ({
      ref: tpl.ref,
      name: tpl.name,
      category: tpl.category,
      scope: tpl.scope,
      version: tpl.currentVersion,
      ...(tpl.description ? { description: tpl.description } : {}),
    }));
    return { content: wrapUntrusted(JSON.stringify({ templates: payload }), 'list_templates', 'template'), ok: true, sources: [] };
  }

  /** One template's skeleton and what it asks for — wrapped, for the reason above. */
  private async getTemplate(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const ref = String(args.templateRef ?? '').trim();
    if (!ref) return this.fail('templateRef is required');
    const tpl = await this.templates.getByRef(ctx.workspaceId, ref);
    const payload = {
      ref: tpl.ref,
      name: tpl.name,
      version: tpl.version,
      category: tpl.meta.category,
      ...(tpl.meta.titlePattern ? { titlePattern: tpl.meta.titlePattern } : {}),
      placeholders: tpl.meta.placeholders,
      ...(tpl.meta.aiInstructions ? { notes: tpl.meta.aiInstructions } : {}),
      tags: tpl.tags,
      relations: tpl.relations,
      ...(tpl.archivedAt ? { archived: true } : {}),
      body: tpl.body.slice(0, MAX_DOC_CHARS),
    };
    return { content: wrapUntrusted(JSON.stringify(payload), 'get_template', 'template'), ok: true, sources: [] };
  }

  private async readDocument(
    args: Record<string, unknown>,
    ctx: AssistantToolContext,
  ): Promise<AssistantToolResult> {
    const documentId = String(args.documentId ?? '');
    const scope = await this.scopeOf(ctx);
    const doc = await this.requireVisibleDocument(documentId, ctx, scope);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);
    await this.permissions.auditBypassRead(ctx.principal, scope, { type: 'document', id: documentId });
    try {
      const content = await this.documents.getContent(documentId);
      const trails = await this.documents.breadcrumbsFor(scope, [documentId]);
      const source: AssistantAskSource = { documentId, title: doc.title, revisionId: content.revisionId, factClass: 'explicit' };
      return {
        content: JSON.stringify({
          documentId,
          title: doc.title,
          breadcrumb: trails.get(documentId) || '(top level)',
          ...this.citeOf(ctx, source),
          markdown: content.markdown.slice(0, MAX_DOC_CHARS),
        }),
        ok: true,
        sources: [source],
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

    const tree = await this.documents.getTree(await this.scopeOf(ctx), projectId, {
      ...(parentId ? { parentId } : {}),
      depth,
    });

    const rows: Array<{
      documentId: string;
      title: string;
      parentId: string | null;
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
          // Stated, never inferred. With depth alone the reader has to work the
          // parent out from row order — "the nearest row above me at depth-1" —
          // and a live model got that wrong on the first real tree it saw,
          // naming a section two levels up as the page's parent.
          parentId: n.parentId ?? null,
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
    const scope = await this.scopeOf(ctx);
    const doc = await this.requireVisibleDocument(documentId, ctx, scope);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);

    const graph = await this.documents.getDocumentGraph(documentId, depth, scope);
    // A page reached through the graph is evidence of the kind the edge is:
    // an `inferred` edge is a model's guess, `frontmatter` the author's word.
    // The weakest edge that led to a node is what the citation inherits.
    const factOf = new Map<string, AssistantAskSource['factClass']>();
    const rank: Record<string, number> = { explicit: 0, curated: 1, frontmatter: 2, inferred: 3 };
    for (const e of graph.edges) {
      const cls = e.extractor as NonNullable<AssistantAskSource['factClass']>;
      if (!(cls in rank)) continue;
      for (const end of [e.from, e.to]) {
        const prev = factOf.get(end);
        if (!prev || (rank[cls] ?? 0) > (rank[prev] ?? 0)) factOf.set(end, cls);
      }
    }
    const sources: AssistantAskSource[] = graph.nodes
      .filter((n) => n.kind === 'document' && n.id !== documentId)
      .slice(0, 8)
      .map((n) => ({ documentId: n.id, title: n.label, factClass: factOf.get(n.id) ?? 'inferred' }));
    return {
      content: JSON.stringify({
        documentId,
        nodes: graph.nodes.map((n) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          distance: n.distance,
          ...(n.kind === 'document' ? this.citeOf(ctx, sources.find((s) => s.documentId === n.id) ?? { documentId: n.id, title: n.label }) : {}),
        })),
        edges: graph.edges.map((e) => ({ from: e.from, to: e.to, type: e.type, confidence: e.confidence })),
      }),
      ok: true,
      sources,
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
    const doc = await this.requireVisibleDocument(documentId, ctx, await this.scopeOf(ctx));
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);

    const { relations } = await this.documents.listRelations(documentId);
    // A draft or unindexed page has no readable content; its graph edges are
    // still worth reporting, so this degrades rather than failing.
    const content = await this.documents.getContent(documentId).catch(() => null);

    const source: AssistantAskSource = { documentId, title: doc.title, factClass: 'explicit' };
    return {
      content: JSON.stringify({
        documentId,
        title: doc.title,
        ...this.citeOf(ctx, source),
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
      sources: [source],
    };
  }

  /**
   * The `cite` field a tool result shows the model (docs/features/38). Stamped
   * onto the source too, so the harness collects it already labelled. Absent
   * when the caller runs no answer to cite into (a background agent).
   */
  private citeOf(ctx: AssistantToolContext, source: AssistantAskSource): { cite?: string } {
    if (!ctx.cite) return {};
    const cite = ctx.cite(source);
    source.cite = cite;
    return { cite };
  }

  /**
   * Model-supplied ids are only honoured when the document lives in the pinned
   * workspace and `scope` may open it (#76). A page the caller cannot see is
   * the same "not found" as one that does not exist: the model learns nothing
   * about it, not even that it is there.
   */
  private async requireVisibleDocument(documentId: string, ctx: AssistantToolContext, scope: AccessScope) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) return null;
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true, title: true },
    });
    if (!doc || doc.workspaceId !== ctx.workspaceId) return null;
    if (!(await this.permissions.visibleDocumentIds(scope, [documentId])).has(documentId)) return null;
    return doc;
  }

  private fail(message: string): AssistantToolResult {
    return { content: JSON.stringify({ error: message }), ok: false, sources: [] };
  }
}
