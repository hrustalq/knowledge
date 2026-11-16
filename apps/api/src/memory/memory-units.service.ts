import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { MemoryBank, MemoryUnit, Prisma } from '@prisma/client';
import { UUID_RE } from '@knowledge/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { withSubjectLock } from '../common/subject-lock.js';
import { GraphService } from '../graph/graph.service.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MEMORY_TIME_FIELDS, cleanTags, isWireDocumentId, readObservationScopes, resolveObservationScopes, tagsWhere, type MemoryTimeField, type ObservationScopes, type TagsMatch } from './memory-facts.js';
import { FILE_DOCUMENT_PREFIX } from './memory-files.js';
import { globMatch } from './memory-observations.js';
import type { BankStatsResponse, DeleteResponse, ListMemoryUnitsResponse, MemoryUnitItem } from './memory-wire.js';

export { isWireDocumentId };

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
   * Rows at once, vectors right after. Clearing facts deletes the observations
   * they supported and resets any surviving co-sources for a rebuild.
   * The memory tool's file chunks stay (#1009): they mirror files the clear
   * does not touch, and recall must find what `view` shows. A file goes
   * through the files wire or the bank page, chunks with it.
   */
  async clear(bank: MemoryBank, type?: string): Promise<DeleteResponse> {
    const { ids } = await this.deleteWhere(bank, { ...(type ? { factType: type } : {}), NOT: { documentId: { startsWith: FILE_DOCUMENT_PREFIX } } });
    return { success: true, message: null, deleted_count: ids.length };
  }

  /** One memory of the bank, deleted (#994): a fact also deletes its observations and resets their other sources. False when the bank holds no such memory. */
  async deleteOne(bank: MemoryBank, memoryId: string): Promise<boolean> {
    return (await this.deleteWhere(bank, { id: memoryId })).matched > 0;
  }

  /** Add a newly retained fact to each resolved scope, without repeating extraction. */
  async addScopeMemberships(bank: Pick<MemoryBank, 'id' | 'workspaceId'>, units: Array<{ id: string; tags: string[]; observationScopes?: ObservationScopes }>, consolidated: boolean): Promise<void> {
    const resolved = units.map((unit) => ({ unit, scopes: resolveObservationScopes(unit.tags, unit.observationScopes) }));
    const tagSets = [...new Map(resolved.flatMap((r) => r.scopes).map((tags) => [JSON.stringify(tags), tags])).values()];
    if (!tagSets.length) return;
    await this.prisma.memoryObservationScope.createMany({
      data: tagSets.map((tags) => ({ id: randomUUID(), workspaceId: bank.workspaceId, bankId: bank.id, tags })),
      skipDuplicates: true,
    });
    const scopes = await this.prisma.memoryObservationScope.findMany({ where: { bankId: bank.id, OR: tagSets.map((tags) => ({ tags: { equals: tags } })) } });
    const idOf = new Map(scopes.map((scope) => [JSON.stringify(scope.tags), scope.id]));
    const at = consolidated ? new Date() : null;
    await this.prisma.memoryObservationScopeMember.createMany({
      data: resolved.flatMap(({ unit, scopes: memberships }) => memberships.map((tags) => ({
        id: randomUUID(), workspaceId: bank.workspaceId, bankId: bank.id, scopeId: idOf.get(JSON.stringify(tags))!, unitId: unit.id, consolidatedAt: at,
      }))),
      skipDuplicates: true,
    });
  }

  /** Delete observations supported by these facts and reset their co-sources only in the affected scopes. Caller holds the bank lock. */
  async invalidateFacts(bankId: string, factIds: string[]): Promise<string[]> {
    if (!factIds.length) return [];
    const affected = await this.prisma.memoryUnit.findMany({
      where: { bankId, factType: 'observation', evidence: { some: { factId: { in: factIds } } } },
      select: { id: true, observationScopeId: true, evidence: { select: { factId: true } } },
    });
    if (!affected.length) return [];
    const observationIds = affected.map((o) => o.id);
    const sourceIds = [...new Set(affected.flatMap((o) => o.evidence.map((e) => e.factId)))];
    // Only the (source, scope) pairs an observation actually stood on (#1166): a co-source keeps its other scopes'
    // consolidation. An observation with no scope (written before scopes) resets its sources in every scope.
    const pairs = new Map<string | null, Set<string>>();
    for (const o of affected) {
      const sources = pairs.get(o.observationScopeId) ?? new Set<string>();
      for (const e of o.evidence) sources.add(e.factId);
      pairs.set(o.observationScopeId, sources);
    }
    await this.prisma.memoryUnit.deleteMany({ where: { id: { in: observationIds } } });
    await this.prisma.memoryObservationScopeMember.updateMany({
      where: { OR: [...pairs].map(([scopeId, sources]) => ({ unitId: { in: [...sources] }, ...(scopeId ? { scopeId } : {}) })) },
      data: { consolidatedAt: null, claimedAt: null },
    });
    await this.prisma.memoryUnit.updateMany({ where: { id: { in: sourceIds } }, data: { consolidatedAt: null, consolidationClaimedAt: null } });
    return observationIds;
  }

  /** Documents are projections of their source facts; no second document table can drift from them. */
  async documents(bank: MemoryBank, query: import('./memory.dto.js').ListDocumentsQueryDto) {
    const field = query.time_field === 'created_at' ? 'createdAt' : 'updatedAt';
    const q = query.q?.trim();
    const filtered = Boolean(q || query.tags?.length || query.start_date || query.end_date);
    // The filters choose documents; each document is then built from all its units, as `document()` builds it (#1166).
    const matching = filtered
      ? await this.prisma.memoryUnit.findMany({
          where: {
            bankId: bank.id,
            factType: { not: 'observation' },
            ...(q ? { OR: [{ documentId: { contains: q, mode: 'insensitive' } }, { sourceText: { contains: q, mode: 'insensitive' } }] } : {}),
            AND: [
              tagsWhere(query.tags, query.tags_match),
              ...(query.start_date || query.end_date ? [{ [field]: { ...(query.start_date ? { gte: new Date(query.start_date) } : {}), ...(query.end_date ? { lt: new Date(query.end_date) } : {}) } }] : []),
            ],
          },
          select: { documentId: true },
          distinct: ['documentId'],
        })
      : null;
    const rows = await this.prisma.memoryUnit.findMany({
      where: { bankId: bank.id, factType: { not: 'observation' }, ...(matching ? { documentId: { in: matching.map((m) => m.documentId) } } : {}) },
      orderBy: [{ [field]: 'desc' }, { id: 'asc' }],
    });
    // ponytail: documents are grouped in memory from source rows; move this projection to SQL if banks routinely hold millions of units.
    const grouped = new Map<string, MemoryUnit[]>();
    for (const row of rows) {
      const list = grouped.get(row.documentId) ?? [];
      list.push(row);
      grouped.set(row.documentId, list);
    }
    const documents = [...grouped.values()].map((units) => {
      const first = units[0]!;
      const text = [...new Set([...units].sort((a, b) => a.position - b.position).map((unit) => unit.sourceText))].join('\n\n');
      return {
        id: first.documentId,
        bank_id: bank.bankId,
        content_hash: createHash('sha256').update(text).digest('hex'),
        created_at: new Date(Math.min(...units.map((u) => u.createdAt.getTime()))).toISOString(),
        updated_at: new Date(Math.max(...units.map((u) => u.updatedAt.getTime()))).toISOString(),
        text_length: text.length,
        memory_unit_count: units.length,
        retain_params: { observation_scopes: first.observationScopes ?? null },
        document_metadata: first.metadata,
        tags: [...new Set(units.flatMap((u) => u.tags))].sort(),
        ...(q ? { matched_fields: [first.documentId.toLowerCase().includes(q.toLowerCase()) ? 'id' : 'original_text'] } : {}),
      };
    });
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return { items: documents.slice(offset, offset + limit), total: documents.length, limit, offset, total_is_estimate: false };
  }

  async document(bank: MemoryBank, documentId: string) {
    const units = await this.documentUnits(bank, documentId);
    const first = units[0]!;
    const text = [...new Set([...units].sort((a, b) => a.position - b.position).map((unit) => unit.sourceText))].join('\n\n');
    return {
      id: documentId,
      bank_id: bank.bankId,
      original_text: text,
      content_hash: createHash('sha256').update(text).digest('hex'),
      created_at: new Date(Math.min(...units.map((u) => u.createdAt.getTime()))).toISOString(),
      updated_at: new Date(Math.max(...units.map((u) => u.updatedAt.getTime()))).toISOString(),
      memory_unit_count: units.length,
      nodes_by_fact_type: Object.fromEntries([...new Set(units.map((u) => u.factType))].map((type) => [type, units.filter((u) => u.factType === type).length])),
      tags: [...new Set(units.flatMap((u) => u.tags))].sort(),
      document_metadata: first.metadata,
      retain_params: { observation_scopes: first.observationScopes ?? null },
      observation_scopes: first.observationScopes ?? null,
    };
  }

  async chunks(bank: MemoryBank, documentId: string, query: { limit?: number; offset?: number }) {
    const units = await this.documentUnits(bank, documentId);
    const chunks = [...new Map(units.map((unit) => [unit.sourceText, unit])).values()].map((unit, chunk_index) => ({
      chunk_id: unit.id,
      document_id: documentId,
      bank_id: bank.bankId,
      chunk_index,
      chunk_text: unit.sourceText,
      created_at: unit.createdAt.toISOString(),
    }));
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return { items: chunks.slice(offset, offset + limit), total: chunks.length, limit, offset };
  }

  async chunk(bank: MemoryBank, chunkId: string) {
    const unit = UUID_RE.test(chunkId) ? await this.prisma.memoryUnit.findFirst({ where: { id: chunkId, bankId: bank.id, factType: { not: 'observation' } } }) : null;
    if (!unit) throw new NotFoundException(t('error.memory.memoryNotFound', { id: chunkId }));
    const siblings = await this.documentUnits(bank, unit.documentId);
    // A chunk is a distinct source text, so its index is its text's place: several units can share one (#1166).
    const chunkIndex = [...new Set(siblings.map((row) => row.sourceText))].indexOf(unit.sourceText);
    return { chunk_id: unit.id, document_id: unit.documentId, bank_id: bank.bankId, chunk_index: Math.max(0, chunkIndex), chunk_text: unit.sourceText, created_at: unit.createdAt.toISOString() };
  }

  async deleteDocument(bank: MemoryBank, documentId: string) {
    if (isWireDocumentId(documentId)) throw new BadRequestException(t('error.memory.documentIdReserved'));
    const done = await this.deleteWhere(bank, { documentId, factType: { not: 'observation' } });
    if (!done.matched) throw new NotFoundException(t('error.memory.memoryNotFound', { id: documentId }));
    return { success: true, message: `Document '${documentId}' deleted`, document_id: documentId, memory_units_deleted: done.matched };
  }

  /** Replace or increment tags and move observation scopes, rebuilding only changed memberships. */
  async updateDocument(bank: MemoryBank, documentId: string, dto: import('./memory.dto.js').UpdateDocumentDto): Promise<{ success: true }> {
    if (isWireDocumentId(documentId)) throw new BadRequestException(t('error.memory.documentIdReserved'));
    if (Array.isArray(dto.tags) && (Array.isArray(dto.add_tags) || Array.isArray(dto.remove_tags))) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'tags', type: 'tags cannot be combined with add_tags or remove_tags' }));
    if (!Array.isArray(dto.tags) && !Array.isArray(dto.add_tags) && !Array.isArray(dto.remove_tags) && dto.observation_scopes === undefined) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'document', type: 'at least one mutable field' }));
    const requestedScopes = dto.observation_scopes === undefined ? undefined : readObservationScopes(dto.observation_scopes) ?? 'combined';
    const invalidated = await withSubjectLock(this.prisma, `memory-bank:${bank.id}`, async () => {
      const units = await this.prisma.memoryUnit.findMany({
        where: { bankId: bank.id, documentId, factType: { not: 'observation' } },
        include: { scopeMembers: { include: { scope: { select: { tags: true } } } } },
      });
      if (!units.length) throw new NotFoundException(t('error.memory.memoryNotFound', { id: documentId }));
      const changed = units.map((unit) => {
        const tags = Array.isArray(dto.tags) ? cleanTags(dto.tags) : cleanTags([...unit.tags.filter((tag) => !(dto.remove_tags ?? []).includes(tag)), ...(dto.add_tags ?? [])]);
        const observationScopes = requestedScopes ?? unit.observationScopes as ObservationScopes | undefined;
        const before = unit.scopeMembers.map((m) => JSON.stringify(m.scope.tags)).sort();
        const after = resolveObservationScopes(tags, observationScopes).map((s) => JSON.stringify(s)).sort();
        const dirty = JSON.stringify(unit.tags) !== JSON.stringify(tags) || JSON.stringify(unit.observationScopes ?? null) !== JSON.stringify(observationScopes ?? null);
        return { unit, tags, observationScopes, dirty, changed: JSON.stringify(unit.tags) !== JSON.stringify(tags) || JSON.stringify(before) !== JSON.stringify(after) };
      });
      const moved = changed.filter((row) => row.changed);
      const removed = await this.invalidateFacts(bank.id, moved.map((row) => row.unit.id));
      if (moved.length) {
        await this.prisma.memoryObservationScopeMember.deleteMany({ where: { unitId: { in: moved.map((row) => row.unit.id) } } });
        await this.addScopeMemberships(bank, moved.map((row) => ({ id: row.unit.id, tags: row.tags, observationScopes: row.observationScopes })), false);
        await this.prisma.memoryUnit.updateMany({ where: { id: { in: moved.map((row) => row.unit.id) } }, data: { consolidatedAt: null, consolidationClaimedAt: null } });
      }
      // A unit the request leaves as it was is not written (#1166): its `updated_at` is what stales a mental model.
      for (const row of changed) if (row.dirty) await this.prisma.memoryUnit.update({ where: { id: row.unit.id }, data: { tags: row.tags, observationScopes: row.observationScopes } });
      return removed;
    });
    await this.dropVectors(bank.workspaceId, invalidated);
    return { success: true };
  }

  async clearObservations(bank: MemoryBank, memoryId?: string): Promise<{ deleted_count: number }> {
    const ids = await withSubjectLock(this.prisma, `memory-bank:${bank.id}`, async () => {
      if (memoryId) {
        const fact = UUID_RE.test(memoryId) ? await this.prisma.memoryUnit.findFirst({ where: { id: memoryId, bankId: bank.id, factType: { not: 'observation' } }, select: { id: true } }) : null;
        if (!fact) throw new NotFoundException(t('error.memory.memoryNotFound', { id: memoryId }));
        const removed = await this.invalidateFacts(bank.id, [fact.id]);
        return [...removed, ...(await this.deleteBareObservations(bank.id))];
      }
      const rows = await this.prisma.memoryUnit.findMany({ where: { bankId: bank.id, factType: 'observation' }, select: { id: true } });
      await this.prisma.memoryUnit.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
      await this.prisma.memoryObservationScopeMember.updateMany({ where: { bankId: bank.id }, data: { consolidatedAt: null, claimedAt: null } });
      await this.prisma.memoryUnit.updateMany({ where: { bankId: bank.id, factType: { not: 'observation' } }, data: { consolidatedAt: null, consolidationClaimedAt: null } });
      return rows.map((row) => row.id);
    });
    await this.dropVectors(bank.workspaceId, ids);
    return { deleted_count: ids.length };
  }

  async observationHistory(bank: MemoryBank, memoryId: string) {
    const observation = UUID_RE.test(memoryId) && await this.prisma.memoryUnit.findFirst({ where: { id: memoryId, bankId: bank.id, factType: 'observation' }, include: { evidence: { include: { fact: { select: { id: true, text: true } } } }, history: { orderBy: { createdAt: 'desc' } } } });
    if (!observation) throw new NotFoundException(t('error.memory.memoryNotFound', { id: memoryId }));
    const source_facts = observation.evidence.map((row) => ({ id: row.fact.id, text: row.fact.text, quote: row.quote }));
    return [{ text: observation.text, created_at: observation.createdAt.toISOString(), source_facts }, ...observation.history.map((row) => ({ text: row.text, created_at: row.createdAt.toISOString(), source_facts: [] }))];
  }

  async tags(bank: MemoryBank, query: import('./memory.dto.js').ListTagsQueryDto) {
    const rows = query.source === 'mental_models'
      ? await this.prisma.memoryMentalModel.findMany({ where: { bankId: bank.id }, select: { tags: true } })
      : await this.prisma.memoryUnit.findMany({ where: { bankId: bank.id }, select: { tags: true } });
    const counts = new Map<string, number>();
    for (const tag of rows.flatMap((row) => row.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const pattern = query.q?.toLowerCase();
    const tags = [...counts].map(([tag, count]) => ({ tag, count })).filter((row) => !pattern || globMatch(pattern, row.tag.toLowerCase())).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    return { items: tags.slice(offset, offset + limit), total: tags.length, limit, offset };
  }

  private async documentUnits(bank: MemoryBank, documentId: string): Promise<MemoryUnit[]> {
    const rows = await this.prisma.memoryUnit.findMany({ where: { bankId: bank.id, documentId, factType: { not: 'observation' } }, orderBy: { position: 'asc' } });
    if (!rows.length) throw new NotFoundException(t('error.memory.memoryNotFound', { id: documentId }));
    return rows;
  }

  async observationScopes(bank: MemoryBank, query: { limit?: number; offset?: number }) {
    const where = { bankId: bank.id, observations: { some: {} } } satisfies Prisma.MemoryObservationScopeWhereInput;
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.memoryObservationScope.findMany({ where, include: { _count: { select: { observations: true } } }, orderBy: [{ observations: { _count: 'desc' } }, { id: 'asc' }], skip: offset, take: limit }),
      this.prisma.memoryObservationScope.count({ where }),
    ]);
    return { scopes: rows.map((row) => ({ tags: row.tags, count: row._count.observations })), total, limit, offset };
  }

  /** Delete selected rows and every observation they supported; reset surviving co-sources for a rebuild. */
  async deleteWhere(bank: MemoryBank, where: Prisma.MemoryUnitWhereInput, alongside?: () => Promise<unknown>): Promise<{ matched: number; ids: string[] }> {
    const done = await withSubjectLock(this.prisma, `memory-bank:${bank.id}`, async () => {
      const ids = (await this.prisma.memoryUnit.findMany({ where: { AND: [where, { bankId: bank.id }] }, select: { id: true } })).map((r) => r.id);
      const observations = await this.invalidateFacts(bank.id, ids);
      if (ids.length) {
        await this.prisma.memoryUnit.deleteMany({ where: { id: { in: ids } } });
        // A deletion leaves no newer row behind: the bank's stamp is what stales a mental model built before it (#1166).
        await this.prisma.memoryBank.update({ where: { id: bank.id }, data: { memoriesDeletedAt: new Date() } });
      }
      await alongside?.();
      return { matched: ids.length, ids: ids.length ? [...ids, ...observations, ...(await this.deleteBareObservations(bank.id))] : observations };
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
    const [byType, documents, last, pending, paused] = await Promise.all([
      this.prisma.memoryUnit.groupBy({ by: ['factType'], where: { bankId: bank.id }, _count: { _all: true } }),
      this.prisma.memoryUnit.findMany({ where: { bankId: bank.id }, distinct: ['documentId'], select: { documentId: true } }),
      this.prisma.memoryUnit.findFirst({ where: { bankId: bank.id }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      this.prisma.memoryUnit.count({ where: { bankId: bank.id, factType: { not: 'observation' }, scopeMembers: { some: { consolidatedAt: null } } } }),
      this.prisma.memoryMentalModel.count({ where: { bankId: bank.id, lastRefreshFailedAt: { not: null } } }),
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
      paused_mental_models: paused,
    };
  }

  /** How many memories each of these banks holds, by bank row id. */
  async counts(bankIds: string[]): Promise<Map<string, number>> {
    if (!bankIds.length) return new Map();
    const rows = await this.prisma.memoryUnit.groupBy({ by: ['bankId'], where: { bankId: { in: bankIds } }, _count: { _all: true } });
    return new Map(rows.map((r) => [r.bankId, r._count._all]));
  }
}
