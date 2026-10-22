import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ChatPlatformKind, ChatSearchHit, ChatSearchResponse } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { canSeeChat, type AccessScope } from '../permissions/access-scope.js';
import { fuseHits } from '../search/ranking.js';
import { telegramMessageUrl } from './adapters/telegram.adapter.js';
import { mattermostPermalink } from './adapters/mattermost.adapter.js';

export interface ChatSearchQuery {
  query: string;
  /** Only groups bound to these projects. */
  projectIds?: string[];
  bindingIds?: string[];
  /** Windows that overlap this span. */
  from?: Date;
  to?: Date;
  limit: number;
}

/** Each leg fetches this many times the limit before fusion. */
const OVERFETCH = 4;
/** The standard RRF constant, as page search's default. */
const RRF_K = 60;
const SNIPPET_CHARS = 400;

/**
 * Where a hit opens on its platform, from what the binding already holds — no
 * platform call at search time. Telegram: the window's first message (a
 * supergroup only). Time/Mattermost: the thread's root, through the team kept
 * on the binding (#407); a channel in no team, or one not yet resolved, has none.
 */
function hitUrl(
  binding: { externalChatId: string; teamName: string | null; integration: { kind: string; serverUrl: string } },
  threadKey: string,
  firstMessageId: string | undefined,
): string | null {
  if (binding.integration.kind === 'telegram') return firstMessageId ? telegramMessageUrl(binding.externalChatId, firstMessageId) : null;
  const root = threadKey || firstMessageId;
  return binding.teamName && binding.integration.serverUrl && root ? mattermostPermalink(binding.integration.serverUrl, binding.teamName, root) : null;
}

/**
 * Chat search (#339, phase 3): the windows of searchable groups the caller
 * may read, ranked by a vector leg and a full-text leg fused with RRF.
 *
 * **ACL first, in PG.** The readable bindings are decided before either leg
 * runs (`canSeeChat` over the workspace's searchable bindings), both legs are
 * restricted to them, and the final read joins `chat_chunks` on them again —
 * so a vector that outlived its row, or a binding switched off mid-query,
 * never yields a hit. An empty set returns before anything is embedded.
 *
 * Every method takes a required `AccessScope`; a system caller would pass
 * `systemScope`. A bot turn passes its audience-clamped scope, which hides a
 * restricted project's chat from a group that could not read it.
 */
@Injectable()
export class ChatSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  /** Whether the workspace has any searchable group at all — what decides if the tools are offered. */
  async anySearchable(workspaceId: string): Promise<boolean> {
    return (await this.prisma.chatChannelBinding.count({ where: { workspaceId, searchableAt: { not: null } }, take: 1 })) > 0;
  }

  /** The searchable bindings of the scope's workspace this caller may read, narrowed by the query's filters. */
  async readableBindings(scope: AccessScope, filter: Pick<ChatSearchQuery, 'projectIds' | 'bindingIds'> = {}) {
    const bindings = await this.prisma.chatChannelBinding.findMany({
      where: {
        workspaceId: scope.workspaceId,
        searchableAt: { not: null },
        ...(filter.bindingIds ? { id: { in: filter.bindingIds } } : {}),
        ...(filter.projectIds ? { projectId: { in: filter.projectIds } } : {}),
      },
      select: { id: true, projectId: true, title: true, externalChatId: true, teamName: true, integration: { select: { kind: true, serverUrl: true } } },
    });
    const projectIds = [...new Set(bindings.flatMap((b) => (b.projectId ? [b.projectId] : [])))];
    const restricted = new Set(
      projectIds.length
        ? (await this.prisma.project.findMany({ where: { id: { in: projectIds }, restricted: true }, select: { id: true } })).map((p) => p.id)
        : [],
    );
    return bindings.filter((b) => canSeeChat(scope, { projectId: b.projectId, projectRestricted: !!b.projectId && restricted.has(b.projectId) }));
  }

  async search(scope: AccessScope, q: ChatSearchQuery): Promise<ChatSearchResponse> {
    const query = q.query.trim();
    if (!query) return { hits: [] };
    const readable = await this.readableBindings(scope, q);
    if (readable.length === 0) return { hits: [] };
    const ids = readable.map((b) => b.id);
    const fetchK = q.limit * OVERFETCH;
    const span = Prisma.sql`${q.from ? Prisma.sql`AND last_at >= ${q.from}` : Prisma.empty} ${q.to ? Prisma.sql`AND first_at <= ${q.to}` : Prisma.empty}`;

    const [vectorHits, textHits] = await Promise.all([
      this.embeddings.embed(query).then((v) => this.graph.nearestChatChunks(scope.workspaceId, v, fetchK, ids)),
      this.prisma.$queryRaw<Array<{ chunkId: string; score: number }>>`
        SELECT id AS "chunkId", ts_rank(search_tsv, plainto_tsquery('russian', ${query}))::float8 AS score
          FROM chat_chunks
         WHERE workspace_id = ${scope.workspaceId}::uuid AND binding_id = ANY(${ids}::uuid[])
           AND search_tsv @@ plainto_tsquery('russian', ${query}) ${span}
         ORDER BY score DESC
         LIMIT ${fetchK}`,
    ]);
    const fused = fuseHits(vectorHits, textHits, fetchK, RRF_K);
    if (fused.length === 0) return { hits: [] };

    // The final say: only rows that exist, in a readable binding, in the span.
    const rows = await this.prisma.chatChunk.findMany({
      where: {
        id: { in: fused.map((h) => h.chunkId) },
        workspaceId: scope.workspaceId,
        bindingId: { in: ids },
        ...(q.from ? { lastAt: { gte: q.from } } : {}),
        ...(q.to ? { firstAt: { lte: q.to } } : {}),
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const kept = fused.filter((h) => byId.has(h.chunkId)).slice(0, q.limit);
    const firsts = await this.prisma.chatMessage.findMany({
      where: { chunkId: { in: kept.map((h) => h.chunkId) } },
      orderBy: { sentAt: 'asc' },
      distinct: ['chunkId'],
      select: { chunkId: true, externalMessageId: true },
    });
    const firstOf = new Map(firsts.map((m) => [m.chunkId, m.externalMessageId]));
    const bindingOf = new Map(readable.map((b) => [b.id, b]));

    return {
      hits: kept.map((h): ChatSearchHit => {
        const row = byId.get(h.chunkId)!;
        const binding = bindingOf.get(row.bindingId)!;
        const platform = binding.integration.kind as ChatPlatformKind;
        const first = firstOf.get(row.id);
        return {
          chunkId: row.id,
          bindingId: row.bindingId,
          chatTitle: binding.title,
          platform,
          projectId: binding.projectId,
          firstAt: row.firstAt.toISOString(),
          lastAt: row.lastAt.toISOString(),
          messageCount: row.messageCount,
          snippet: row.text.length > SNIPPET_CHARS ? `${row.text.slice(0, SNIPPET_CHARS)}…` : row.text,
          url: hitUrl(binding, row.threadKey, first),
          score: h.score,
        };
      }),
    };
  }
}
