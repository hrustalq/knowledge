import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { AssistantAskSource } from '@knowledge/contracts';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { SearchService } from '../search/search.service.js';

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
}

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
    ];
  }

  async execute(name: string, args: Record<string, unknown>, ctx: AssistantToolContext): Promise<AssistantToolResult> {
    try {
      // Session-scoped ACL re-check on EVERY call — not just once per request.
      await this.access.requireRole(ctx.principal, ctx.workspaceId, 'viewer');
      switch (name) {
        case 'search_knowledge':
          return await this.searchKnowledge(args, ctx);
        case 'read_document':
          return await this.readDocument(args, ctx);
        case 'explore_document_graph':
          return await this.exploreGraph(args, ctx);
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
