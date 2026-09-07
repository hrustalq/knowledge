import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { AssistantAskSource, AssistantChatMode, AssistantUiBlock, DocumentCategory } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { MergeRequestsService } from '../documents/merge-requests.service.js';
import { StorageService } from '../storage/storage.service.js';
import { SearchService } from '../search/search.service.js';

/** Tools that mutate the workspace — require 'editor', not just 'viewer'. Exported so
 * AssistantService can also filter them out of the tool list when mode = 'ask'. */
export const WRITE_TOOLS = new Set(['create_document', 'propose_update']);

/**
 * Everything a tool run is allowed to see. `workspaceId` is pinned from the
 * request AFTER AclGuard verified the caller's membership — the model's tool
 * arguments can never widen it, so a prompt-injected "read workspace X"
 * instruction dead-ends here (context-engineering containment).
 */
export interface AssistantToolContext {
  principal: Principal;
  workspaceId: string;
}

export interface AssistantToolResult {
  /** JSON string fed back to the model as the tool message. */
  content: string;
  ok: boolean;
  /** Documents this call touched — surfaced as answer sources. */
  sources: AssistantAskSource[];
  /** Set only by render_component — an existing product component (GraphView/ActivityFeed/
   * SearchWidget) the assistant wants the chat pane to render inline for this turn. */
  uiBlock?: AssistantUiBlock;
}

const UI_COMPONENTS = new Set(['graph', 'activity', 'search']);

const MAX_DOC_CHARS = 24_000;

/**
 * The assistant's tool surface (docs/features/09). Three read-only tools, all
 * scoped to the caller's session:
 *  - every execution re-checks workspace membership via AccessService (a
 *    revoked session/membership cuts the model off mid-conversation);
 *  - document ids coming from the model are re-verified to belong to the
 *    pinned workspace before any content is fetched;
 *  - failures are returned to the model as `{ "error": … }` payloads instead
 *    of throwing, so one bad call never 500s the whole /ask request.
 */
@Injectable()
export class AssistantToolsService {
  private readonly logger = new Logger(AssistantToolsService.name);

  constructor(
    private readonly access: AccessService,
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly documents: DocumentsService,
    private readonly mergeRequests: MergeRequestsService,
    private readonly storage: StorageService,
  ) {}

  /** @param mode 'ask' (default) hides create_document/propose_update from the model entirely,
   * regardless of the caller's role — a lighter-weight guarantee than the editor-role check in
   * `execute`, which still applies on top of this when mode = 'agent'.
   * @param opts.ui defaults true — set false for callers whose UI can't render an AssistantUiBlock
   * (e.g. the one-shot /assistant/ask endpoint), so the model is never offered a tool it has no way
   * to have an effect through. */
  definitions(mode: AssistantChatMode = 'ask', opts: { ui?: boolean } = {}): ChatCompletionFunctionTool[] {
    const ui = opts.ui ?? true;
    const all: ChatCompletionFunctionTool[] = [
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
          name: 'render_component',
          description:
            'Render an existing, already-shipped product UI component inline in the chat instead of describing ' +
            'it in prose — the same GraphView/ActivityFeed/SearchWidget components used on document pages, so ' +
            'the user gets the real interactive view. Use "graph" when the user wants to see how a document ' +
            'relates to others (requires documentId, must be a document already discussed or looked up this ' +
            'turn). Use "activity" to show the live activity stream (documentId optional — omit for the whole ' +
            'workspace). Use "search" to drop in a pre-filled, auto-run search box for a topic instead of just ' +
            'listing snippets yourself (needs query). Call this in addition to your normal text reply, not ' +
            'instead of it — the component supplements what you say. Call at most once per component per turn.',
          parameters: {
            type: 'object',
            properties: {
              component: { type: 'string', enum: ['graph', 'activity', 'search'], description: 'Which existing component to render' },
              documentId: { type: 'string', description: 'UUID scoping the component (required for graph; optional for activity; unused for search)' },
              query: { type: 'string', description: 'Search query to pre-fill and auto-run (only used when component = search)' },
            },
            required: ['component'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'create_document',
          description:
            'Create a brand-new page in this workspace with the given markdown content. It is visible immediately ' +
            '(there is nothing existing to protect for a new page) — use this only when the user is clearly asking ' +
            'for a NEW document, not a change to one that already exists (use propose_update for that instead).',
          parameters: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Document title' },
              markdown: { type: 'string', description: 'Full markdown content of the new page' },
              category: { type: 'string', description: 'Optional category; defaults to "other"' },
              parentId: { type: 'string', description: 'Optional UUID of a parent document to nest this under' },
              projectId: {
                type: 'string',
                description: "Optional UUID of the owning project; defaults to the workspace's first project",
              },
            },
            required: ['title', 'markdown'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'propose_update',
          description:
            'Propose a change to an EXISTING document: drafts the new markdown on a fresh branch and opens a merge ' +
            'request against its default branch for a human to review and merge — this NEVER edits the live page ' +
            'directly. Use read_document first so the new markdown is a complete replacement, not a partial diff.',
          parameters: {
            type: 'object',
            properties: {
              documentId: { type: 'string', description: 'UUID of the existing document to propose a change to' },
              markdown: { type: 'string', description: 'Full replacement markdown content for the page' },
              title: { type: 'string', description: 'Merge request title, e.g. summarizing the change' },
              description: { type: 'string', description: 'Optional merge request description explaining why' },
            },
            required: ['documentId', 'markdown', 'title'],
          },
        },
      },
    ];
    const scoped = mode === 'agent' ? all : all.filter((t) => !WRITE_TOOLS.has(t.function.name));
    return ui ? scoped : scoped.filter((t) => t.function.name !== 'render_component');
  }

  async execute(name: string, args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    try {
      // Session-scoped ACL re-check on EVERY call — not just once per request;
      // write tools additionally require 'editor' (never widened by the model).
      await this.access.requireRole(ctx.principal, ctx.workspaceId, WRITE_TOOLS.has(name) ? 'editor' : 'viewer');
      switch (name) {
        case 'search_knowledge':
          return await this.searchKnowledge(args, ctx);
        case 'read_document':
          return await this.readDocument(args, ctx);
        case 'explore_document_graph':
          return await this.exploreGraph(args, ctx);
        case 'render_component':
          return await this.renderComponent(args, ctx);
        case 'create_document':
          return await this.createDocument(args, ctx);
        case 'propose_update':
          return await this.proposeUpdate(args, ctx);
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

  private async searchKnowledge(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const query = String(args.query ?? '').slice(0, 2_000).trim();
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

  private async readDocument(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const documentId = String(args.documentId ?? '');
    const doc = await this.requireWorkspaceDocument(documentId, ctx);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);
    try {
      const content = await this.documents.getContent(documentId);
      return {
        content: JSON.stringify({ documentId, title: doc.title, markdown: content.markdown.slice(0, MAX_DOC_CHARS) }),
        ok: true,
        sources: [{ documentId, title: doc.title }],
      };
    } catch {
      return this.fail(`Document "${doc.title}" has no readable content yet (draft or unindexed)`);
    }
  }

  private async exploreGraph(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
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

  private async createDocument(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const title = String(args.title ?? '').trim().slice(0, 300);
    const markdown = String(args.markdown ?? '');
    if (!title) return this.fail('title is required');
    if (!markdown.trim()) return this.fail('markdown is required');
    const authorId = ctx.principal.userId; // matches DEV_PRINCIPAL's stub id in AUTH_MODE=none

    // Every document needs a project. A project id from args is validated
    // against the pinned workspace inside createDocument, so a prompt-injected
    // id from another tenant is rejected there rather than trusted here.
    const projectId =
      typeof args.projectId === 'string' && args.projectId
        ? args.projectId
        : await this.defaultProjectId(ctx.workspaceId);
    if (!projectId) return this.fail('workspace has no project to create the document in');

    const created = await this.documents.createDocument(
      {
        workspaceId: ctx.workspaceId, // pinned — never from args
        projectId,
        title,
        content: { mode: 'inline', format: 'markdown', text: markdown },
        ...(typeof args.category === 'string' && args.category ? { category: args.category as DocumentCategory } : {}),
        ...(typeof args.parentId === 'string' && args.parentId ? { parentId: args.parentId } : {}),
      },
      authorId,
    );
    return {
      content: JSON.stringify({
        documentId: created.documentId,
        title,
        status: created.status,
        note: 'Created and published immediately — it is a new page, so there was nothing to review.',
      }),
      ok: true,
      sources: [{ documentId: created.documentId, title }],
    };
  }

  /** Oldest project in the workspace — the "General" one after the projects backfill. */
  private async defaultProjectId(workspaceId: string): Promise<string | null> {
    const project = await this.prisma.project.findFirst({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return project?.id ?? null;
  }

  private async proposeUpdate(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const documentId = String(args.documentId ?? '');
    const markdown = String(args.markdown ?? '');
    const title = String(args.title ?? '').trim().slice(0, 300);
    const doc = await this.requireWorkspaceDocument(documentId, ctx);
    if (!doc) return this.fail(`Document ${documentId} not found in this workspace`);
    if (!markdown.trim()) return this.fail('markdown is required');
    if (!title) return this.fail('title is required');
    const authorId = ctx.principal.userId; // matches DEV_PRINCIPAL's stub id in AUTH_MODE=none

    const branchName = `assistant/${Date.now()}`;

    try {
      await this.documents.createBranch(documentId, { name: branchName });
      const revision = await this.documents.createRevision(
        documentId,
        { branch: branchName, message: title, contentType: 'text/markdown' },
        undefined,
        authorId,
      );
      const row = await this.prisma.documentRevision.findUnique({ where: { id: revision.revisionId } });
      if (!row) return this.fail('Draft revision disappeared before it could be written');
      await this.storage.putObjectText(row.s3Key, markdown, 'text/markdown');
      await this.documents.finalizeRevision(documentId, revision.revisionId);

      const description = typeof args.description === 'string' ? args.description.slice(0, 4_000) : undefined;
      const mr = await this.mergeRequests.create(
        documentId,
        { sourceBranch: branchName, title, ...(description ? { description } : {}) },
        authorId,
      );
      return {
        content: JSON.stringify({
          documentId,
          documentTitle: doc.title,
          mergeRequestId: mr.mergeRequest.mergeRequestId,
          branch: branchName,
          title,
          note: 'Opened as a merge request — a human must review and merge it before the change goes live.',
        }),
        ok: true,
        sources: [{ documentId, title: doc.title }],
      };
    } catch (err) {
      return this.fail(err instanceof Error ? err.message : 'Failed to propose the update');
    }
  }

  private async renderComponent(args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    const component = String(args.component ?? '');
    if (!UI_COMPONENTS.has(component)) {
      return this.fail(`Unknown component "${component}" — must be one of: graph, activity, search`);
    }

    if (component === 'search') {
      const query = String(args.query ?? '').trim().slice(0, 500);
      if (!query) return this.fail('query is required for the search component');
      return {
        content: JSON.stringify({ rendered: 'search', query }),
        ok: true,
        sources: [],
        uiBlock: { component: 'search', props: { initialQuery: query } },
      };
    }

    // graph and activity both scope to a documentId — re-validated against the pinned workspace
    // exactly like read_document/explore_document_graph, so the model can never render a component
    // pointed at a document outside this workspace.
    const rawDocumentId = typeof args.documentId === 'string' ? args.documentId : '';
    let doc: { id: string; title: string } | null = null;
    if (rawDocumentId) {
      doc = await this.requireWorkspaceDocument(rawDocumentId, ctx);
      if (!doc) return this.fail(`Document ${rawDocumentId} not found in this workspace`);
    } else if (component === 'graph') {
      return this.fail('documentId is required for the graph component');
    }

    return {
      content: JSON.stringify({ rendered: component, documentId: doc?.id ?? null }),
      ok: true,
      sources: doc ? [{ documentId: doc.id, title: doc.title }] : [],
      uiBlock: { component: component as 'graph' | 'activity', props: doc ? { documentId: doc.id } : {} },
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
