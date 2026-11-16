import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MemoryBank, type MemoryUnit } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AUTHOR_ID_STUB } from '../activity/actor.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { AiUsageService, estimateTokens } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { DecisionClient, type DecisionRoute } from '../assistant/decision.client.js';
import { askEach } from '../common/ask-each.js';
import { parseModelJson } from '../common/model-json.js';
import { withSubjectLock } from '../common/subject-lock.js';
import { wrapUntrusted } from '../common/untrusted.js';
import type { Env } from '../config/env.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { GraphService } from '../graph/graph.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { consolidationDay, consolidationPrompt, observationSettings, readConsolidation, refinement, type ConsolidationEntry } from './memory-observations.js';
import { MemoryMentalModelsService } from './memory-mental-models.service.js';

/** New facts one consolidation call reads, at most. */
const BATCH_FACTS = 10;
/** Existing observations offered per fact, nearest first, and for the whole call. */
const CANDIDATES_PER_FACT = 5;
const MAX_CANDIDATES = 20;
/** A claim this old is a dead worker's, and the facts are claimed again. */
const CLAIM_STALE_MS = 10 * 60_000;
/** Past this many observations in one scope the nearest-neighbour leg runs bank-wide and PG filters. */
const SCOPE_ID_CAP = 5000;
const SCREEN_QUESTION = {
  instructions: 'An AI agent keeps observations: durable statements that facts support. Decide whether the new fact bears on the observation.',
  criteria: { true: 'The fact supports, refines or contradicts the observation: they are about the same thing.', false: 'The fact is about something else.' },
};

/** Why a bank's facts are not consolidated right now. */
export type ConsolidationBlock = 'disabled' | 'no-model';
export type ConsolidationStop = ConsolidationBlock | 'cap' | 'budget' | 'failed';

export interface PassResult {
  /** Facts the consolidator read (and marked consolidated). */
  facts: number;
  created: number;
  refined: number;
  /** Why the pass ended before the backlog did; null when nothing was left. */
  stopped: ConsolidationStop | null;
}

type Fact = MemoryUnit & { entities: Array<{ entityKey: string; name: string }> };
type Claimed = { scopeId: string; tags: string[]; facts: Fact[] };

const pendingMember = (alias: string, stale: Date) =>
  Prisma.sql`${Prisma.raw(alias)}.consolidated_at IS NULL
    AND (${Prisma.raw(alias)}.claimed_at IS NULL OR ${Prisma.raw(alias)}.claimed_at < ${stale})`;

/**
 * Observations (#993): a bank's new facts folded into durable statements that
 * keep their evidence. The worker runs it — on its tick
 * (`MemoryConsolidationSweeper`) and for `POST …/consolidate` through an
 * operation row — and the API asks only `blocker`.
 *
 * - **Off unless a model is routed** to the `consolidator` (purpose
 *   `extraction`, never the inline config), the bank has not switched
 *   observations off, the workspace budget has room, and the bank is under
 *   its daily cap (`MEMORY_CONSOLIDATION_DAILY_CALLS`). Each is checked before
 *   the call it would pay for.
 * - **Claimed by one guarded statement** (`FOR UPDATE SKIP LOCKED`), one tag
 *   scope at a time, so two workers never read the same facts and an
 *   observation never mixes facts filed under different tags.
 * - **Refine, never overwrite.** New wording keeps the old in
 *   `memory_observation_history`; evidence is only ever added. A quote must be
 *   verbatim in its fact (`readConsolidation`) and an observation with no
 *   evidence is never written.
 * - **Untrusted both ways.** The facts and the observations reach the model
 *   only inside the wrapper; the bank's mission is the one trusted line.
 */
@Injectable()
export class MemoryConsolidationService {
  private readonly logger = new Logger(MemoryConsolidationService.name);
  private readonly dailyCalls: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly agents: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly client: AssistantClient,
    private readonly decision: DecisionClient,
    private readonly mentalModels: MemoryMentalModelsService,
    config: ConfigService<Env, true>,
  ) {
    this.dailyCalls = config.get('MEMORY_CONSOLIDATION_DAILY_CALLS', { infer: true });
  }

  /** Whether consolidation may run for this bank at all, read before anything is claimed. The budget and the cap are per call. */
  async blocker(bank: Pick<MemoryBank, 'workspaceId' | 'enableObservations'>): Promise<ConsolidationBlock | null> {
    if (bank.enableObservations === false || this.dailyCalls === 0) return 'disabled';
    return (await this.agentFor(bank.workspaceId)) ? null : 'no-model';
  }

  /** Distinct source facts waiting in at least one selected scope. */
  async pending(bankId: string, observationScopes?: string[][] | null): Promise<number> {
    if (observationScopes?.length === 0) return 0;
    return this.prisma.memoryUnit.count({
      where: {
        bankId, factType: { not: 'observation' }, scopeMembers: { some: { consolidatedAt: null } },
        ...(observationScopes ? { OR: observationScopes.map((tags) => ({ tags: { hasEvery: tags } })) } : {}),
      },
    });
  }

  /** Up to `maxBatches` calls' worth of the selected backlog. */
  async pass(bank: MemoryBank, opts: { maxBatches: number; now?: number; observationScopes?: string[][] | null }): Promise<PassResult> {
    const now = opts.now ?? Date.now();
    const result: PassResult = { facts: 0, created: 0, refined: 0, stopped: null };
    if (bank.enableObservations === false || this.dailyCalls === 0) return { ...result, stopped: 'disabled' };
    const agent = await this.agentFor(bank.workspaceId);
    if (!agent) return { ...result, stopped: 'no-model' };
    if (opts.observationScopes?.length === 0) return result;
    const route = await this.decision.routeFor(bank.workspaceId);
    for (let i = 0; i < opts.maxBatches; i++) {
      const claimed = await this.claim(bank.id, now, opts.observationScopes);
      if (!claimed) return result;
      const settings = observationSettings(bank, claimed.tags);
      let facts = claimed.facts;
      if (settings.sourceFactsMaxTokens >= 0) {
        let used = 0;
        facts = facts.filter((fact, i) => {
          used += estimateTokens(fact.text);
          return i === 0 || used <= settings.sourceFactsMaxTokens;
        });
        const kept = new Set(facts.map((f) => f.id));
        await this.release(claimed.scopeId, claimed.facts.filter((f) => !kept.has(f.id)).map((f) => f.id));
      }
      const done = await this.batch(bank, claimed.scopeId, claimed.tags, facts, agent, route, now, settings).catch(async (e: Error) => {
        this.logger.warn({ msg: 'memory consolidation batch failed', bankId: bank.id, error: e.message });
        return 'failed' as const;
      });
      if (typeof done === 'string') {
        await this.release(claimed.scopeId, facts.map((f) => f.id));
        return { ...result, stopped: done };
      }
      result.facts += facts.length;
      result.created += done.created;
      result.refined += done.refined;
    }
    if (result.facts) await this.mentalModels.afterConsolidation(bank).catch((error: Error) => this.logger.warn(`Mental models not queued after consolidation: ${error.message}`));
    return result;
  }

  /** The consolidator, when a model is routed to it and it is on; else null. */
  private async agentFor(workspaceId: string): Promise<ResolvedAgent | null> {
    const agent = await this.agents.resolve(workspaceId, 'consolidator');
    return agent.enabled && agent.config.enabled && agent.config.modelId ? agent : null;
  }

  /** The oldest pending membership's scope, up to a batch of it, claimed with SKIP LOCKED. Targets match the source fact's full tags. */
  private async claim(bankId: string, now: number, observationScopes?: string[][] | null): Promise<Claimed | null> {
    const stale = new Date(now - CLAIM_STALE_MS);
    const selected = observationScopes ? Prisma.sql`AND (${Prisma.join(observationScopes.map((tags) => Prisma.sql`u.tags @> ${tags}::text[]`), ' OR ')})` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{ scope_id: string; unit_id: string }>>`
      WITH scope AS (
        SELECT m.scope_id FROM memory_observation_scope_members m
        JOIN memory_units u ON u.id = m.unit_id
         WHERE m.bank_id = ${bankId}::uuid AND ${pendingMember('m', stale)} ${selected}
         ORDER BY u.created_at, u.id LIMIT 1
      ), picked AS (
        SELECT m.scope_id, m.unit_id FROM memory_observation_scope_members m
        JOIN memory_units u ON u.id = m.unit_id, scope
         WHERE m.bank_id = ${bankId}::uuid AND ${pendingMember('m', stale)} AND m.scope_id = scope.scope_id ${selected}
         ORDER BY u.created_at, u.id
         LIMIT ${BATCH_FACTS}
         FOR UPDATE OF m SKIP LOCKED
      )
      UPDATE memory_observation_scope_members m SET claimed_at = ${new Date(now)}
       FROM picked WHERE m.scope_id = picked.scope_id AND m.unit_id = picked.unit_id
      RETURNING m.scope_id, m.unit_id`;
    if (!rows.length) return null;
    const scope = await this.prisma.memoryObservationScope.findUnique({ where: { id: rows[0]!.scope_id } });
    if (!scope) return null;
    const facts = await this.prisma.memoryUnit.findMany({
      where: { id: { in: rows.map((r) => r.unit_id) }, bankId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { entities: { select: { entityKey: true, name: true } } },
    });
    return { scopeId: scope.id, tags: scope.tags, facts };
  }

  private async release(scopeId: string, ids: string[]): Promise<void> {
    if (ids.length) await this.prisma.memoryObservationScopeMember.updateMany({ where: { scopeId, unitId: { in: ids }, consolidatedAt: null }, data: { claimedAt: null } });
  }

  /** One call of the bank's daily cap, taken in one guarded statement: true when there was one left. */
  private async takeCall(bankId: string, now: number): Promise<boolean> {
    const day = consolidationDay(now);
    const taken = await this.prisma.$executeRaw`
      UPDATE memory_banks
         SET consolidation_calls = CASE WHEN consolidation_day = ${day}::date THEN consolidation_calls + 1 ELSE 1 END,
             consolidation_day = ${day}::date
       WHERE id = ${bankId}::uuid AND (consolidation_day IS DISTINCT FROM ${day}::date OR consolidation_calls < ${this.dailyCalls})`;
    return taken > 0;
  }

  private async batch(bank: MemoryBank, scopeId: string, tags: string[], facts: Fact[], agent: ResolvedAgent, route: DecisionRoute | null, now: number, settings: ReturnType<typeof observationSettings>): Promise<{ created: number; refined: number } | ConsolidationStop> {
    let candidates = await this.candidates(bank, scopeId, facts);
    if (route && candidates.length) candidates = await this.screen(route, facts, candidates);
    try {
      await this.usage.assertWithinBudget(bank.workspaceId, AUTHOR_ID_STUB);
    } catch {
      return 'budget';
    }
    if (!(await this.takeCall(bank.id, now))) return 'cap';
    const { content } = await this.client.chatWithUsage(
      { config: agent.config, userId: AUTHOR_ID_STUB, operation: 'memory-consolidate', locale: 'source' },
      [
        { role: 'system', content: agent.instructions },
        { role: 'user', content: consolidationPrompt(facts, candidates, settings.mission) },
      ],
      { json: true },
    );
    return this.write(bank, scopeId, tags, facts, candidates, readConsolidation(parseModelJson(content), facts, candidates), now, settings);
  }

  /** The scope's observations nearest to any of the facts, best first. PG has the final say on scope and type. */
  private async candidates(bank: MemoryBank, scopeId: string, facts: Fact[]): Promise<MemoryUnit[]> {
    const scope: Prisma.MemoryUnitWhereInput = { bankId: bank.id, factType: 'observation', observationScopeId: scopeId };
    const ids = await this.prisma.memoryUnit.findMany({ where: scope, select: { id: true }, take: SCOPE_ID_CAP + 1 });
    if (!ids.length) return [];
    const allowed = ids.length <= SCOPE_ID_CAP ? ids.map((r) => r.id) : null;
    const vectors = await this.embeddings.embedBatch(facts.map((f) => f.text));
    const hits = await Promise.all(vectors.map((v) => this.graph.nearestMemoryUnits(bank.workspaceId, bank.id, v, CANDIDATES_PER_FACT, allowed)));
    // Round-robin over the facts' lists, so every fact gets its nearest in before the cap.
    const order: string[] = [];
    for (let rank = 0; rank < CANDIDATES_PER_FACT; rank++) for (const list of hits) if (list[rank] && !order.includes(list[rank]!.chunkId)) order.push(list[rank]!.chunkId);
    const rows = await this.prisma.memoryUnit.findMany({ where: { ...scope, id: { in: order.slice(0, MAX_CANDIDATES) } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return order.flatMap((id) => byId.get(id) ?? []).slice(0, MAX_CANDIDATES);
  }

  /**
   * The decision model screens each (fact, observation) pair before the
   * consolidator sees the observation. A pre-filter, never a verdict: an
   * observation stays when any pair clears the threshold or a question fails.
   */
  private async screen(route: DecisionRoute, facts: Fact[], candidates: MemoryUnit[]): Promise<MemoryUnit[]> {
    const pairs = candidates.flatMap((o, oi) => facts.map((f) => ({ oi, fact: f.text, observation: o.text })));
    const { answers } = await askEach(
      pairs,
      (p) =>
        this.decision.noul(
          { route, userId: AUTHOR_ID_STUB, operation: 'memory-consolidate-screen' },
          { fact: wrapUntrusted(p.fact, 'consolidate', 'memory'), observation: wrapUntrusted(p.observation, 'consolidate', 'memory') },
          SCREEN_QUESTION,
        ),
      () => false,
    );
    const kept = new Set(pairs.flatMap((p, i) => (answers[i] == null || answers[i]! >= route.thresholds.memory ? [p.oi] : [])));
    return candidates.filter((_, i) => kept.has(i));
  }

  /**
   * The answer, written: new observations, refined ones, their evidence, and
   * the batch's facts marked read — under the bank's lock, in one
   * transaction. A new observation's vector goes first (an orphan is reaped);
   * a refined one's after the commit.
   */
  private async write(bank: MemoryBank, scopeId: string, tags: string[], facts: Fact[], candidates: MemoryUnit[], entries: ConsolidationEntry[], now: number, settings: ReturnType<typeof observationSettings>): Promise<{ created: number; refined: number }> {
    const creates = entries.filter((e) => e.target === null).map((e) => ({ id: randomUUID(), entry: e }));
    const refines = entries.filter((e) => e.target !== null).map((e) => ({ id: candidates[e.target!]!.id, entry: e }));
    const reworded = refines.filter((r) => r.entry.text !== null);
    const vectors = await this.embeddings.embedBatch([...creates, ...reworded].map((x) => x.entry.text!));
    await this.graph.upsertMemoryUnits(bank.workspaceId, bank.id, creates.map((c, i) => ({ unitId: c.id, embedding: vectors[i]! })), now);

    let written: { created: number; refined: number; reworded: Set<string> };
    try {
      written = await withSubjectLock(this.prisma, `memory-bank:${bank.id}`, async () => {
        // A scope change while the model was thinking removes the membership, so the old scope cannot gain evidence.
        const alive = new Set((await this.prisma.memoryObservationScopeMember.findMany({ where: { scopeId, unitId: { in: facts.map((f) => f.id) } }, select: { unitId: true } })).map((r) => r.unitId));
        const evidenceOf = (e: ConsolidationEntry) => {
          const kept: ConsolidationEntry['evidence'] = [];
          let used = 0;
          for (const ev of e.evidence) {
            if (!alive.has(facts[ev.fact]!.id)) continue;
            used += estimateTokens(facts[ev.fact]!.text);
            if (kept.length && settings.sourceFactsMaxTokensPerObservation >= 0 && used > settings.sourceFactsMaxTokensPerObservation) break;
            kept.push(ev);
          }
          return kept;
        };
        const rows = (observationId: string, e: ConsolidationEntry) =>
          evidenceOf(e).map((ev) => ({ workspaceId: bank.workspaceId, bankId: bank.id, observationId, factId: facts[ev.fact]!.id, quote: ev.quote }));
        const entityRows = (unitId: string, e: ConsolidationEntry) =>
          evidenceOf(e).flatMap((ev) => facts[ev.fact]!.entities.map((x) => ({ workspaceId: bank.workspaceId, bankId: bank.id, unitId, entityKey: x.entityKey, name: x.name })));
        const existing = await this.prisma.memoryUnit.count({ where: { bankId: bank.id, observationScopeId: scopeId, factType: 'observation' } });
        const remaining = settings.maxObservations < 0 ? creates.length : Math.max(0, settings.maxObservations - existing);
        let created = 0;
        for (const { id, entry } of creates) {
          const evidence = rows(id, entry);
          if (!evidence.length || created >= remaining) continue;
          const sources = evidenceOf(entry).map((ev) => facts[ev.fact]!);
          const at = (f: Fact) => f.occurredStart ?? f.mentionedAt;
          const starts = sources.map(at).filter((d): d is Date => d !== null);
          const ends = sources.map((f) => f.occurredEnd ?? at(f)).filter((d): d is Date => d !== null);
          const mentions = sources.map((f) => f.mentionedAt).filter((d): d is Date => d !== null);
          await this.prisma.memoryUnit.create({
            data: {
              id,
              workspaceId: bank.workspaceId,
              bankId: bank.id,
              text: entry.text!,
              factType: 'observation',
              tags,
              observationScopeId: scopeId,
              documentId: `observation:${id}`,
              sourceText: '',
              occurredStart: starts.length ? new Date(Math.min(...starts.map(Number))) : null,
              occurredEnd: ends.length ? new Date(Math.max(...ends.map(Number))) : null,
              mentionedAt: mentions.length ? new Date(Math.max(...mentions.map(Number))) : null,
              createdBy: AUTHOR_ID_STUB,
            },
          });
          await this.prisma.memoryObservationEvidence.createMany({ data: evidence });
          await this.prisma.memoryUnitEntity.createMany({ data: entityRows(id, entry), skipDuplicates: true });
          created++;
        }
        const current = new Map(
          (await this.prisma.memoryUnit.findMany({ where: { id: { in: refines.map((r) => r.id) }, bankId: bank.id, observationScopeId: scopeId }, select: { id: true, text: true } })).map((r) => [r.id, r.text]),
        );
        const changed = new Set<string>();
        let refined = 0;
        for (const { id, entry } of refines) {
          const evidence = rows(id, entry);
          const was = current.get(id);
          if (was === undefined || !evidence.length) continue;
          const { text, previous } = refinement(was, entry);
          if (previous !== null) {
            await this.prisma.memoryObservationHistory.create({ data: { workspaceId: bank.workspaceId, bankId: bank.id, observationId: id, text: previous } });
            await this.prisma.memoryUnit.update({ where: { id }, data: { text } });
            changed.add(id);
          }
          await this.prisma.memoryObservationEvidence.createMany({ data: evidence, skipDuplicates: true });
          await this.prisma.memoryUnitEntity.createMany({ data: entityRows(id, entry), skipDuplicates: true });
          refined++;
        }
        if (alive.size) {
          await this.prisma.memoryObservationScopeMember.updateMany({ where: { scopeId, unitId: { in: [...alive] } }, data: { consolidatedAt: new Date(now), claimedAt: null } });
          await this.prisma.$executeRaw`
            UPDATE memory_units u SET consolidated_at = ${new Date(now)}, consolidation_claimed_at = NULL
            WHERE u.id IN (${Prisma.join([...alive].map((id) => Prisma.sql`${id}::uuid`))})
              AND NOT EXISTS (SELECT 1 FROM memory_observation_scope_members m WHERE m.unit_id = u.id AND m.consolidated_at IS NULL)`;
        }
        return { created, refined, reworded: changed };
      });
    } catch (e) {
      await this.graph.deleteMemoryUnits(bank.workspaceId, creates.map((c) => c.id)).catch(() => undefined);
      throw e;
    }
    const refreshed = reworded.flatMap((r, i) => (written.reworded.has(r.id) ? [{ unitId: r.id, embedding: vectors[creates.length + i]! }] : []));
    if (refreshed.length) {
      await this.graph.upsertMemoryUnits(bank.workspaceId, bank.id, refreshed, now).catch((e: Error) => this.logger.warn(`Refined observation vectors not rewritten: ${e.message}`));
    }
    return { created: written.created, refined: written.refined };
  }
}
