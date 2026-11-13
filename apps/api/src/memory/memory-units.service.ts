import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MemoryBank, MemoryUnit, Prisma } from '@prisma/client';
import { UUID_RE } from '@knowledge/contracts';
import { withSubjectLock } from '../common/subject-lock.js';
import { GraphService } from '../graph/graph.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEMORY_TIME_FIELDS, tagsWhere, type MemoryTimeField, type TagsMatch } from './memory-facts.js';
import type { BankStatsResponse, DeleteResponse, ListMemoryUnitsResponse, MemoryUnitItem } from './memory-wire.js';


export interface ListMemoriesQuery {
  type?: string;
  q?: string;
  document_id?: string;
  tags?: string[];
  tags_match?: TagsMatch;
  time_field?: MemoryTimeField;
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
}

type UnitWithNames = MemoryUnit & { entities: Array<{ name: string }>; evidence: Array<{ factId: string }> };

/** What a list or get reads of a memory beside its row: its entity names and, on an observation, its evidence. */
export const UNIT_INCLUDE = { entities: { select: { name: true } }, evidence: { select: { factId: true } } } as const;

export function memoryItem(row: UnitWithNames): MemoryUnitItem {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    id: row.id,
    text: row.text,
    context: row.context ?? '',
    date: iso(row.occurredStart ?? row.mentionedAt) ?? '',
    fact_type: row.factType,
    document_id: row.documentId,
    mentioned_at: iso(row.mentionedAt),
    occurred_start: iso(row.occurredStart),
    occurred_end: iso(row.occurredEnd),
    entities: row.entities.map((e) => e.name).join(', '),
    chunk_id: null,
    // An observation's proof is its evidence; a fact is its own.
    proof_count: row.factType === 'observation' ? row.evidence.length : 1,
    tags: row.tags,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    state: 'valid',
    updated_at: row.updatedAt.toISOString(),
    source_memory_ids: row.evidence.map((e) => e.factId),
  };
}

/**
 * Reading and deleting what a bank holds (#986 phase 1). Every method takes
 * the bank row `MemoryAccessService.bank` resolved — the only way to one — so
 * each query is by that bank's id and nothing reaches across banks.
 */
@Injectable()
export class MemoryUnitsService {
  private readonly logger = new Logger(MemoryUnitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  async list(bank: MemoryBank, query: ListMemoriesQuery): Promise<ListMemoryUnitsResponse> {
    const field = MEMORY_TIME_FIELDS[query.time_field ?? 'created_at'];
    const q = query.q?.trim();
    const span = query.start_date || query.end_date ? { [field]: { ...(query.start_date ? { gte: new Date(query.start_date) } : {}), ...(query.end_date ? { lt: new Date(query.end_date) } : {}) } } : {};
    const where: Prisma.MemoryUnitWhereInput = {
      bankId: bank.id,
      ...(query.type ? { factType: query.type } : {}),
      ...(query.document_id ? { documentId: query.document_id } : {}),
      ...(q ? { OR: [{ text: { contains: q, mode: 'insensitive' } }, { context: { contains: q, mode: 'insensitive' } }] } : {}),
      AND: [tagsWhere(query.tags, query.tags_match), span],
    };
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.memoryUnit.findMany({ where, orderBy: [{ [field]: 'desc' }, { id: 'asc' }], skip: offset, take: limit, include: UNIT_INCLUDE }),
      this.prisma.memoryUnit.count({ where }),
    ]);
    return { items: rows.map(memoryItem), total, limit, offset };
  }

  async get(bank: MemoryBank, memoryId: string): Promise<MemoryUnitItem & { type: string }> {
    const row = UUID_RE.test(memoryId)
      ? await this.prisma.memoryUnit.findFirst({ where: { id: memoryId, bankId: bank.id }, include: UNIT_INCLUDE })
      : null;
    if (!row) throw new NotFoundException(t('error.memory.memoryNotFound', { id: memoryId }));
    return { ...memoryItem(row), type: row.factType };
  }

  /**
   * `DELETE …/memories`: every memory of the bank, or those of one fact type.
   * Rows at once, vectors right after. Clearing facts leaves the observations
   * they supported with less evidence, and deletes those left with none.
   */
  async clear(bank: MemoryBank, type?: string): Promise<DeleteResponse> {
    const { ids } = await this.deleteWhere(bank, type ? { factType: type } : {});
    return { success: true, message: null, deleted_count: ids.length };
  }

  /** One memory of the bank, deleted (#994): a fact also leaves the observations it supported, which go too once they have no evidence. False when the bank holds no such memory. */
  async deleteOne(bank: MemoryBank, memoryId: string): Promise<boolean> {
    return (await this.deleteWhere(bank, { id: memoryId })).matched > 0;
  }

  /**
   * The bank's memories `where` picks, deleted under the bank's lock, with
   * whatever `alongside` deletes in the same transaction (#1008: the graph's
   * entity rows). The observations left with no evidence follow; every
   * vector is dropped once it commits. `matched` counts what `where` picked,
   * `ids` everything deleted.
   */
  async deleteWhere(bank: MemoryBank, where: Prisma.MemoryUnitWhereInput, alongside?: () => Promise<unknown>): Promise<{ matched: number; ids: string[] }> {
    const done = await withSubjectLock(this.prisma, `memory-bank:${bank.id}`, async () => {
      const ids = (await this.prisma.memoryUnit.findMany({ where: { AND: [where, { bankId: bank.id }] }, select: { id: true } })).map((r) => r.id);
      if (ids.length) await this.prisma.memoryUnit.deleteMany({ where: { id: { in: ids } } });
      await alongside?.();
      return { matched: ids.length, ids: ids.length ? [...ids, ...(await this.deleteBareObservations(bank.id))] : [] };
    });
    await this.dropVectors(bank.workspaceId, done.ids);
    return done;
  }

  /**
   * The bank's observations left with no evidence (#993) — their last fact was
   * deleted — deleted in turn. Call it in the transaction that deleted the
   * facts; drop the returned ids' vectors after it commits.
   */
  async deleteBareObservations(bankId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      DELETE FROM memory_units o
       WHERE o.bank_id = ${bankId}::uuid AND o.fact_type = 'observation'
         AND NOT EXISTS (SELECT 1 FROM memory_observation_evidence e WHERE e.observation_id = o.id)
      RETURNING o.id`;
    return rows.map((r) => r.id);
  }

  /** The vectors of rows already deleted. A failure leaves orphans no recall returns; the reap removes them. */
  async dropVectors(workspaceId: string, unitIds: string[]): Promise<void> {
    await this.graph.deleteMemoryUnits(workspaceId, unitIds).catch((e: Error) => this.logger.warn(`Memory vectors not deleted, the reap will: ${e.message}`));
  }

  async stats(bank: MemoryBank): Promise<BankStatsResponse> {
    const [byType, documents, last, pending] = await Promise.all([
      this.prisma.memoryUnit.groupBy({ by: ['factType'], where: { bankId: bank.id }, _count: { _all: true } }),
      this.prisma.memoryUnit.findMany({ where: { bankId: bank.id }, distinct: ['documentId'], select: { documentId: true } }),
      this.prisma.memoryUnit.findFirst({ where: { bankId: bank.id }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.memoryUnit.count({ where: { bankId: bank.id, factType: { not: 'observation' }, consolidatedAt: null } }),
    ]);
    const counts = Object.fromEntries(byType.map((r) => [r.factType, r._count._all]));
    return {
      bank_id: bank.bankId,
      total_nodes: byType.reduce((n, r) => n + r._count._all, 0),
      total_links: 0,
      total_documents: documents.length,
      nodes_by_fact_type: counts,
      links_by_link_type: {},
      links_by_fact_type: {},
      links_breakdown: {},
      pending_operations: 0,
      failed_operations: 0,
      last_memory_write_at: last?.updatedAt.toISOString() ?? null,
      pending_consolidation: pending,
      failed_consolidation: 0,
      total_observations: counts.observation ?? 0,
    };
  }

  /** How many memories each of these banks holds, by bank row id. */
  async counts(bankIds: string[]): Promise<Map<string, number>> {
    if (!bankIds.length) return new Map();
    const rows = await this.prisma.memoryUnit.groupBy({ by: ['bankId'], where: { bankId: { in: bankIds } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.bankId, r._count._all]));
  }
}
