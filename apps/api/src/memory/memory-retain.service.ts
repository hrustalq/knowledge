import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { MemoryBank, Prisma } from '@prisma/client';
import type { Locale } from '@knowledge/contracts';
import { randomUUID } from 'node:crypto';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { createMasker } from '../common/mask.js';
import { parseModelJson } from '../common/model-json.js';
import { withSubjectLock } from '../common/subject-lock.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import { EntityAliasService } from '../graph/entity-alias.service.js';
import { GraphService } from '../graph/graph.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { extractionBatches, extractionPrompt, readFacts, type Fact, type RetainItem } from './memory-facts.js';
import { MemoryUnitsService } from './memory-units.service.js';
import type { TokenUsage } from './memory-wire.js';

/** Retained text one extraction call reads, at most. Batches fill up to it. */
const EXTRACTION_BATCH_CHARS = 24_000;

export interface RetainInput {
  workspaceId: string;
  bank: Pick<MemoryBank, 'id' | 'mission'>;
  /** Who retains: the row's author, and whose budget an extraction call spends. */
  userId: string;
  locale: Locale;
  items: RetainItem[];
  /**
   * The async retain this run belongs to. Its items were masked before its row
   * was written (`maskItems`), so they are not masked again; and its units
   * replace whatever an earlier, interrupted run of it wrote.
   */
  operationId?: string;
  /** Store each item exactly as given, one unit per item: no extraction call (#1007). For a wire whose text must stay exact. */
  verbatim?: boolean;
  /** Write the units already consolidated, so the consolidation pass never claims them (#1007). */
  consolidated?: boolean;
  /**
   * Asked under the bank's lock, in the transaction that would write the
   * units, before anything is replaced: false writes nothing and the retain
   * answers `superseded`. A file's index (#1009) passes the check that its
   * text is still what was embedded, and marks it indexed in the same step.
   */
  guard?: () => Promise<boolean>;
}

/** One masker for a whole request, over each item's content and context: the same value gets the same placeholder throughout. */
export function maskItems(items: RetainItem[]): RetainItem[] {
  const mask = createMasker();
  return items.map((item) => ({ ...item, content: mask(item.content), context: item.context ? mask(item.context) : null }));
}

interface Unit {
  id: string;
  item: RetainItem;
  text: string;
  sourceText: string;
  context: string | null;
  fact: Fact | null;
  /** The client's entities, then the extractor's: a name as written and the key it folds from. */
  entities: Array<{ name: string; key: string }>;
}

/**
 * Retain (#986 phase 1): mask, extract, embed, store. One service for both
 * doors — the API calls it inside a request for a sync retain, the worker for
 * an async one — so it takes ids, never a principal.
 *
 * - **Masked first.** One masker per request, over content and context, before
 *   a model or a store sees either. An async retain's items arrive masked:
 *   its operation row must not hold a secret either.
 * - **Never fails for want of a model.** Facts are extracted only when a model
 *   is routed at `extraction` and the budget allows; a missing route, a spent
 *   budget, a failed call or an unreadable answer all store the masked text
 *   verbatim, one unit per item.
 * - **Vector first, row second**, as chat search packs a window: a crash leaves
 *   vectors with no row, which no recall returns and the reap removes.
 * - **A `document_id` retained before is replaced**, in the transaction that
 *   writes its new units, under the bank's lock so two posts of one document
 *   cannot both insert.
 */
@Injectable()
export class MemoryRetainService {
  private readonly logger = new Logger(MemoryRetainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    private readonly aliases: EntityAliasService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    private readonly agents: AgentRegistryService,
    private readonly usage: AiUsageService,
    private readonly client: AssistantClient,
    private readonly units: MemoryUnitsService,
  ) {}

  async retain(input: RetainInput): Promise<{ units: number; usage: TokenUsage | null; superseded?: true }> {
    // Only the worker builds the index (on boot). Without it the rows would be
    // stored and never ranked, so say what is missing instead.
    if (!(await this.graph.memoryIndexReady(this.embeddings.dimension))) {
      throw new ServiceUnavailableException(t('error.memory.storeNotReady'));
    }
    const items = input.operationId ? input.items : maskItems(input.items);
    const { facts, usage } = input.verbatim ? { facts: new Map<number, Fact[]>(), usage: null } : await this.extract(input, items);

    const units: Unit[] = items.flatMap((item, i) =>
      (facts.get(i) ?? [null]).map((fact) => ({
        id: randomUUID(),
        item,
        text: fact?.text ?? item.content,
        sourceText: item.content,
        context: item.context,
        fact,
        entities: [...item.entities, ...(fact?.entities ?? []).map((name) => ({ name, key: name }))],
      })),
    );
    const vectors = await this.embeddings.embedBatch(units.map((u) => (u.context ? `${u.context}\n${u.text}` : u.text)));
    const entities = await this.entityRows(input, units);

    await this.graph.upsertMemoryUnits(input.workspaceId, input.bank.id, units.map((u, i) => ({ unitId: u.id, embedding: vectors[i]! })), Date.now());
    const replaces = [...new Set(items.filter((i) => !i.append).map((i) => i.documentId))];
    let replaced: string[] | null;
    try {
      replaced = await withSubjectLock(this.prisma, `memory-bank:${input.bank.id}`, async () => {
        if (input.guard && !(await input.guard())) return null;
        const old = await this.prisma.memoryUnit.findMany({
          // Facts only: an observation is consolidation's, and a client's document_id never names one.
          where: { bankId: input.bank.id, factType: { not: 'observation' }, OR: [{ documentId: { in: replaces } }, ...(input.operationId ? [{ operationId: input.operationId }] : [])] },
          select: { id: true },
        });
        await this.prisma.memoryUnit.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
        await this.prisma.memoryUnit.createMany({ data: units.map((u) => this.row(input, u)) });
        await this.prisma.memoryUnitEntity.createMany({ data: entities });
        return [...old.map((o) => o.id), ...(old.length ? await this.units.deleteBareObservations(input.bank.id) : [])];
      });
    } catch (e) {
      await this.graph.deleteMemoryUnits(input.workspaceId, units.map((u) => u.id)).catch(() => undefined);
      throw e;
    }
    if (!replaced) {
      await this.graph.deleteMemoryUnits(input.workspaceId, units.map((u) => u.id)).catch(() => undefined);
      return { units: 0, usage, superseded: true };
    }
    // The rows are gone already; a failure here leaves orphans for the reap.
    await this.graph.deleteMemoryUnits(input.workspaceId, replaced).catch((e: Error) => this.logger.warn(`Replaced memory vectors not deleted, the reap will: ${e.message}`));
    return { units: units.length, usage };
  }

  private row(input: RetainInput, u: Unit): Prisma.MemoryUnitCreateManyInput {
    const at = u.item.timestamp ? new Date(u.item.timestamp) : null;
    return {
      id: u.id,
      workspaceId: input.workspaceId,
      bankId: input.bank.id,
      text: u.text,
      factType: u.fact?.type ?? 'world',
      context: u.context,
      tags: u.item.tags,
      metadata: u.item.metadata,
      documentId: u.item.documentId,
      sourceText: u.sourceText,
      occurredStart: u.fact?.occurredStart ?? at,
      occurredEnd: u.fact?.occurredEnd ?? null,
      mentionedAt: at,
      createdBy: input.userId,
      operationId: input.operationId ?? null,
      consolidatedAt: input.consolidated ? new Date() : null,
    };
  }

  /** One row per (unit, canonical key): folded, then resolved through the workspace's aliases, so two spellings are one entity. */
  private async entityRows(input: RetainInput, units: Unit[]): Promise<Prisma.MemoryUnitEntityCreateManyInput[]> {
    const raw = [...new Set(units.flatMap((u) => u.entities.map((e) => e.key)))];
    const resolved = await this.aliases.resolveAll(input.workspaceId, raw);
    const keyOf = new Map(raw.map((r, i) => [r, resolved[i]!]));
    return units.flatMap((u) => {
      const seen = new Set<string>();
      return u.entities.flatMap(({ name, key }) => {
        const entityKey = keyOf.get(key)!;
        if (!entityKey || seen.has(entityKey)) return [];
        seen.add(entityKey);
        return [{ workspaceId: input.workspaceId, bankId: input.bank.id, unitId: u.id, entityKey, name }];
      });
    });
  }

  /** The facts of each item the model split, by item index; an item missing here is stored verbatim. */
  private async extract(input: RetainInput, items: RetainItem[]): Promise<{ facts: Map<number, Fact[]>; usage: TokenUsage | null }> {
    const facts = new Map<number, Fact[]>();
    const agent = await this.agents.resolve(input.workspaceId, 'memorist');
    // A model routed at extraction, or nothing: the env block's model is the
    // assistant's, and an install that configured none must still retain.
    if (!agent.enabled || !agent.config.enabled || !agent.config.modelId) return { facts, usage: null };
    const spent: TokenUsage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    let called = false;
    let offset = 0;
    for (const batch of extractionBatches(items, EXTRACTION_BATCH_CHARS)) {
      try {
        await this.usage.assertWithinBudget(input.workspaceId, input.userId);
        const { content, tokens } = await this.client.chatWithUsage(
          { config: agent.config, userId: input.userId, operation: 'memory-extract', locale: 'source' },
          [
            { role: 'system', content: agent.instructions },
            { role: 'user', content: extractionPrompt(batch, input.bank.mission) },
          ],
          { json: true },
        );
        called = true;
        spent.input_tokens += tokens.promptTokens;
        spent.output_tokens += tokens.completionTokens;
        spent.total_tokens += tokens.totalTokens;
        for (const [i, found] of readFacts(parseModelJson(content), batch.length)) facts.set(offset + i, found);
      } catch (e) {
        // Budget spent, provider down, timeout: this batch is stored as it was written.
        this.logger.warn({ msg: 'memory extraction skipped; storing verbatim', workspaceId: input.workspaceId, error: String(e) });
      }
      offset += batch.length;
    }
    return { facts, usage: called ? spent : null };
  }
}
