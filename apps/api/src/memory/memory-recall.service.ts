import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, type MemoryBank, type MemoryUnit } from '@prisma/client';
import { estimateTokens } from '../ai/ai-usage.service.js';
import { DecisionClient } from '../assistant/decision.client.js';
import { askEach } from '../common/ask-each.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { GraphService } from '../graph/graph.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fuseHits } from '../search/ranking.js';
import { tagsWhere, type TagsMatch } from './memory-facts.js';
import type { RecallResponse, RecallResult } from './memory-wire.js';

export interface RecallQuery {
  query: string;
  types?: string[];
  tags?: string[];
  tagsMatch?: TagsMatch;
  budget?: 'low' | 'mid' | 'high';
  maxTokens?: number;
  window?: { start: Date; end: Date };
  minScores?: { semantic?: number | null; keyword?: number | null; reranker?: number | null; final?: number | null };
  prune?: boolean;
  /** `include.entities`: the map of entities the results name. On unless the client sent null. */
  entities?: boolean;
  chunks?: boolean;
  /** `include.source_facts`: the facts the returned observations stand on, within these budgets (-1 = none). */
  sourceFacts?: { maxTokens: number; perObservation: number } | null;
  /** `prefer_observations`: drop a raw fact a returned observation stands on, and backfill. */
  preferObservations?: boolean;
  /** Who asks: the person a prune's decision calls are billed to. */
  userId: string;
}

type Hit = { chunkId: string; score: number };
type Row = MemoryUnit & { entities: Array<{ entityKey: string; name: string }>; evidence: Array<{ factId: string }> };
const ROW_INCLUDE = { entities: { select: { entityKey: true, name: true } }, evidence: { select: { factId: true } } } as const;

/** How many candidates each leg fetches, by the request's `budget`. */
export const BUDGET_FETCH = { low: 20, mid: 50, high: 100 } as const;
/** Hindsight's default for `max_tokens`. */
export const DEFAULT_MAX_TOKENS = 4096;
const RRF_K = 60;
/** The best hits of the semantic and keyword legs whose entities seed the entity leg. */
const ENTITY_SEEDS = 5;
/**
 * A tag or type filter is decided in PG first and handed to every leg as an
 * id list, so a filtered-out memory never takes a slot.
 * ponytail: past this many matching memories the legs run bank-wide and the final PG read filters; give the vector vertex the tags if a bank's one tag ever holds more.
 */
const FILTER_ID_CAP = 5000;
const PRUNE_THRESHOLD = 0.5;
const PRUNE_QUESTION = {
  instructions: 'An AI agent asked a question of its long-term memory. Decide whether the memory helps answer the query.',
  criteria: { true: 'The memory states something that helps answer the query.', false: 'The memory is about something else, or adds nothing to an answer.' },
};

/**
 * Best first, while the running estimate stays within `maxTokens`. An
 * estimate (~4 characters a token, `estimateTokens`), not a tokenizer count.
 */
export function cutToTokens<T extends { text: string }>(rows: T[], maxTokens: number): T[] {
  if (maxTokens < 0) return rows;
  const kept: T[] = [];
  let used = 0;
  for (const row of rows) {
    used += estimateTokens(row.text);
    if (used > maxTokens) break;
    kept.push(row);
  }
  return kept;
}

/** Four rankings into one: the two retrieval legs fused, the two expansion legs fused, then both — `fuseHits` each time, so ranks decide and raw scores never mix. */
export function fuseLegs(semantic: Hit[], keyword: Hit[], entity: Hit[], temporal: Hit[], k: number): Hit[] {
  const plain = (hits: Hit[]): Hit[] => hits.map(({ chunkId, score }) => ({ chunkId, score }));
  return plain(fuseHits(plain(fuseHits(semantic, keyword, k, RRF_K)), plain(fuseHits(entity, temporal, k, RRF_K)), k, RRF_K));
}

/**
 * Recall (#986 phase 2): the memories of one bank that answer a query.
 *
 * **The bank first.** Every method takes the bank row
 * `MemoryAccessService.bank` resolved, so an unreadable bank is refused before
 * anything is embedded, and every leg and the final read are held to that
 * bank's id.
 *
 * **PG has the final say.** The legs only nominate ids; the rows are then
 * loaded by id, workspace, bank and the request's filter, so a vector whose
 * row is gone, or a memory the filter excludes, is never served.
 */
@Injectable()
export class MemoryRecallService {
  private readonly logger = new Logger(MemoryRecallService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly decision: DecisionClient,
  ) {}

  async recall(bank: MemoryBank, q: RecallQuery): Promise<RecallResponse> {
    // No reranker runs here, so a floor on its score can keep nothing meaningful: refused, as Hindsight does.
    if (q.minScores?.reranker != null) throw new BadRequestException(t('error.memory.noReranker'));
    const rows = await this.ranked(bank, q);
    const kept = q.preferObservations && mixesRaw(q.types) ? preferObservations(rows, q.maxTokens ?? DEFAULT_MAX_TOKENS) : cutToTokens(rows, q.maxTokens ?? DEFAULT_MAX_TOKENS);
    return {
      results: kept.map(({ row, scores }) => result(row, scores)),
      ...(q.entities === false ? {} : { entities: entityStates(kept.map((k) => k.row)) }),
      ...(q.chunks ? { chunks: {} } : {}),
      ...(q.sourceFacts ? await this.sourceFacts(bank, kept.map((k) => k.row), q.sourceFacts) : {}),
    };
  }

  /**
   * The facts the observations among `rows` stand on, observation by
   * observation in rank order, each within its own budget and all within the
   * total. Loaded by id from this bank, as every result is.
   */
  private async sourceFacts(bank: MemoryBank, rows: Row[], budget: { maxTokens: number; perObservation: number }): Promise<Pick<RecallResponse, 'source_facts' | 'source_facts_truncated'>> {
    const wanted = [...new Set(rows.flatMap((r) => (r.factType === 'observation' ? r.evidence.map((e) => e.factId) : [])))];
    const found = wanted.length
      ? await this.prisma.memoryUnit.findMany({ where: { id: { in: wanted }, workspaceId: bank.workspaceId, bankId: bank.id }, include: ROW_INCLUDE })
      : [];
    const byId = new Map(found.map((r) => [r.id, r]));
    const out: Record<string, RecallResult> = {};
    let used = 0;
    let truncated = false;
    for (const obs of rows.filter((r) => r.factType === 'observation')) {
      let mine = 0;
      for (const { factId } of obs.evidence) {
        const fact = byId.get(factId);
        if (!fact || out[factId]) continue;
        const cost = estimateTokens(fact.text);
        if ((budget.perObservation >= 0 && mine + cost > budget.perObservation) || (budget.maxTokens >= 0 && used + cost > budget.maxTokens)) {
          truncated = true;
          continue;
        }
        mine += cost;
        used += cost;
        out[factId] = result(fact);
      }
    }
    return { source_facts: out, source_facts_truncated: truncated };
  }

  /** The bank's memories for a query, best first and uncut, as text a model may read: wrapped untrusted. */
  async recallForModel(bank: MemoryBank, q: RecallQuery, tool: string): Promise<{ text: string; results: RecallResult[] }> {
    const { results } = await this.recall(bank, { ...q, entities: false });
    const body = results.map((r, i) => `[M${i + 1}] ${r.occurred_start ? `(${r.occurred_start.slice(0, 10)}) ` : ''}${r.text}`).join('\n');
    return { text: wrapUntrusted(body || '(no memories found)', tool, 'memory'), results };
  }

  private async ranked(bank: MemoryBank, q: RecallQuery): Promise<Array<{ row: Row; text: string; scores: RecallResult['scores'] }>> {
    const query = q.query.trim();
    if (!query) return [];
    const filter: Prisma.MemoryUnitWhereInput = { ...(q.types?.length ? { factType: { in: q.types } } : {}), AND: [tagsWhere(q.tags, q.tagsMatch)] };
    const filtered = Boolean(q.types?.length || q.tags?.length);
    let allowed: string[] | null = null;
    if (filtered) {
      const ids = await this.prisma.memoryUnit.findMany({ where: { bankId: bank.id, ...filter }, select: { id: true }, take: FILTER_ID_CAP + 1 });
      if (ids.length === 0) return [];
      if (ids.length <= FILTER_ID_CAP) allowed = ids.map((r) => r.id);
    }
    const fetchK = BUDGET_FETCH[q.budget ?? 'mid'];
    const among = allowed ? Prisma.sql`AND u.id = ANY(${allowed}::uuid[])` : Prisma.empty;

    const [semantic, keyword, temporal] = await Promise.all([
      this.embeddings
        .embed(query)
        .then((v) => this.graph.nearestMemoryUnits(bank.workspaceId, bank.id, v, fetchK, allowed))
        .then((hits) => hits.filter((h) => q.minScores?.semantic == null || h.score >= q.minScores.semantic)),
      // Any of the query's words, ranked by how many and how often: a question shares few words with its answer.
      this.prisma.$queryRaw<Hit[]>`
        WITH q AS (SELECT to_tsquery('russian', replace(plainto_tsquery('russian', ${query})::text, ' & ', ' | ')) AS tsq)
        SELECT u.id AS "chunkId", ts_rank(u.search_tsv, q.tsq)::float8 AS score
          FROM memory_units u, q
         WHERE u.bank_id = ${bank.id}::uuid AND u.search_tsv @@ q.tsq ${among}
           AND ts_rank(u.search_tsv, q.tsq) >= ${q.minScores?.keyword ?? 0}
         ORDER BY score DESC
         LIMIT ${fetchK}`,
      q.window
        ? this.prisma.$queryRaw<Hit[]>`
            SELECT u.id AS "chunkId", 1::float8 AS score
              FROM memory_units u
             WHERE u.bank_id = ${bank.id}::uuid ${among}
               AND COALESCE(u.occurred_start, u.mentioned_at) <= ${q.window.end}
               AND COALESCE(u.occurred_end, u.occurred_start, u.mentioned_at) >= ${q.window.start}
             ORDER BY COALESCE(u.occurred_start, u.mentioned_at) DESC
             LIMIT ${fetchK}`
        : [],
    ]);
    const seeds = fuseHits(semantic, keyword, ENTITY_SEEDS, RRF_K).map((h) => h.chunkId);
    // Memories that share an entity with the best hits, most shared first.
    const entity = seeds.length
      ? await this.prisma.$queryRaw<Hit[]>`
          SELECT u.id AS "chunkId", count(DISTINCT theirs.entity_key)::float8 AS score
            FROM memory_unit_entities mine
            JOIN memory_unit_entities theirs ON theirs.bank_id = mine.bank_id AND theirs.entity_key = mine.entity_key
            JOIN memory_units u ON u.id = theirs.unit_id
           WHERE mine.bank_id = ${bank.id}::uuid AND mine.unit_id = ANY(${seeds}::uuid[])
             AND theirs.unit_id <> ALL(${seeds}::uuid[]) ${among}
           GROUP BY u.id
           ORDER BY score DESC
           LIMIT ${fetchK}`
      : [];

    const fused = fuseLegs(semantic, keyword, entity, temporal, fetchK).filter((h) => q.minScores?.final == null || h.score >= q.minScores.final);
    if (fused.length === 0) return [];
    // The final say: rows that exist, in this bank of this workspace, and pass the filter.
    const rows = await this.prisma.memoryUnit.findMany({
      where: { id: { in: fused.map((h) => h.chunkId) }, workspaceId: bank.workspaceId, bankId: bank.id, ...filter },
      include: ROW_INCLUDE,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const semanticOf = new Map(semantic.map((h) => [h.chunkId, h.score]));
    const keywordOf = new Map(keyword.map((h) => [h.chunkId, h.score]));
    const ranked = fused.flatMap((h) => {
      const row = byId.get(h.chunkId);
      // `scores` carries what was computed for this result and leaves out what was not.
      return row ? [{ row, text: row.text, scores: { final: h.score, ...(semanticOf.has(row.id) ? { semantic: semanticOf.get(row.id) } : {}), ...(keywordOf.has(row.id) ? { keyword: keywordOf.get(row.id) } : {}) } }] : [];
    });
    return q.prune ? this.prune(bank, q, query, ranked) : ranked;
  }

  /**
   * `rerank.prune`, when a decision model is routed: drop what it judges no
   * help. A pre-filter, never a verdict — with no route the request's flag is
   * ignored, and a question that fails keeps its memory.
   */
  private async prune<R extends { row: Row }>(bank: MemoryBank, q: RecallQuery, query: string, ranked: R[]): Promise<R[]> {
    const route = await this.decision.routeFor(bank.workspaceId);
    if (!route) return ranked;
    const { answers } = await askEach(
      ranked,
      (r) => this.decision.noul({ route, userId: q.userId, operation: 'memory-recall' }, { query, memory: wrapUntrusted(r.row.text, 'recall', 'memory') }, PRUNE_QUESTION),
      () => false,
    );
    const kept = ranked.filter((_, i) => answers[i] == null || answers[i]! >= PRUNE_THRESHOLD);
    if (kept.length < ranked.length) this.logger.debug(`Recall pruned ${ranked.length - kept.length} of ${ranked.length} memories`);
    return kept;
  }
}

/** Whether a request's types ask for observations and a raw type together: `prefer_observations` does nothing otherwise. No types = all of them. */
const mixesRaw = (types: string[] | undefined): boolean => !types?.length || (types.includes('observation') && types.some((t) => t !== 'observation'));

/**
 * `prefer_observations`: cut to the budget, drop the raw facts the kept
 * observations stand on, and cut again so the freed room is backfilled. Each
 * round can only add observations, so it settles.
 */
export function preferObservations<T extends { text: string; row: { id: string; factType: string; evidence: Array<{ factId: string }> } }>(rows: T[], maxTokens: number): T[] {
  let kept = cutToTokens(rows, maxTokens);
  for (;;) {
    const covered = new Set(kept.flatMap((k) => (k.row.factType === 'observation' ? k.row.evidence.map((e) => e.factId) : [])));
    const next = cutToTokens(rows.filter((r) => r.row.factType === 'observation' || !covered.has(r.row.id)), maxTokens);
    if (next.length === kept.length && next.every((r, i) => r === kept[i])) return kept;
    kept = next;
  }
}

function result(row: Row, scores?: RecallResult['scores']): RecallResult {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: row.id,
    text: row.text,
    type: row.factType,
    entities: row.entities.map((e) => e.name),
    context: row.context,
    occurred_start: iso(row.occurredStart),
    occurred_end: iso(row.occurredEnd),
    mentioned_at: iso(row.mentionedAt),
    document_id: row.documentId,
    metadata: (row.metadata ?? {}) as Record<string, string>,
    chunk_id: null,
    tags: row.tags,
    source_fact_ids: row.evidence.map((e) => e.factId),
    ...(scores ? { scores } : {}),
  };
}

/** The entities the results name, keyed by name, each with the returned observations that name it. */
function entityStates(rows: Row[]): NonNullable<RecallResponse['entities']> {
  const out: NonNullable<RecallResponse['entities']> = {};
  for (const r of rows) {
    for (const e of r.entities) {
      const state = (out[e.name] ??= { entity_id: e.entityKey, canonical_name: e.name, observations: [] });
      if (r.factType === 'observation') state.observations.push({ text: r.text, mentioned_at: r.mentionedAt?.toISOString() ?? null });
    }
  }
  return out;
}
