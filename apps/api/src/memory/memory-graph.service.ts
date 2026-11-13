import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MemoryBank } from '@prisma/client';
import { normalizeEntityKey } from '@knowledge/contracts';
import { randomUUID } from 'node:crypto';
import { createMasker } from '../common/mask.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryAccessService, type MemoryCaller } from './memory-access.service.js';
import type { RetainItem } from './memory-facts.js';
import {
  assertGraphNames,
  deleteEntitiesMessage,
  deleteObservationsMessage,
  deleteRelationsMessage,
  entityNotFound,
  newInBatch,
  observationDocumentId,
  observationPrefix,
  readEntities,
  relationKey,
  type GraphEntity,
  type GraphRelation,
  type ReadGraph,
} from './memory-graph.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { MemoryRateService } from './memory-rate.service.js';
import { MemoryUnitsService } from './memory-units.service.js';

type EntityRow = { id: string; name: string; entityType: string };

/** A read's graph, and whether this server's ceiling cut it short. */
export interface GraphRead {
  graph: ReadGraph;
  capped: boolean;
}

const EMPTY: GraphRead = { graph: { entities: [], relations: [] }, capped: false };
/** Facts only: an observation (#993) is consolidation's, and no graph observation is ever one. */
const FACTS = { factType: { not: 'observation' } } as const;

/**
 * A bank's graph (#1008): the MCP reference memory server's nine operations
 * over a bank, with its rules (`memory-graph.ts`) and these rows:
 *
 * - an entity and a relation are `memory_entities` / `memory_relations` rows,
 *   never a vertex or an edge of the workspace relation graph;
 * - an observation is a `memory_units` fact, verbatim and masked, written
 *   through `MemoryIntakeService` like any retain, so recall finds it and
 *   consolidation reads it. Its document id is its own
 *   (`graph:{entity}:{seq}`): a retain replaces what a document id held, and
 *   a shared one would wipe the entity's other observations.
 *
 * Every method takes a caller already resolved for what it does (the MCP
 * tools ask `MemoryAccessService`). Reads spend the recall rate, writes the
 * retain rate. A bank that does not exist reads as an empty graph, and only
 * a write that stores something creates it.
 *
 * API-only, as the intake it writes through.
 */
@Injectable()
export class MemoryGraphService {
  private readonly maxEntities: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: MemoryAccessService,
    private readonly intake: MemoryIntakeService,
    private readonly units: MemoryUnitsService,
    private readonly rate: MemoryRateService,
    config: ConfigService<Env, true>,
  ) {
    this.maxEntities = config.get('MEMORY_GRAPH_READ_MAX_ENTITIES', { infer: true });
  }

  // --- reads -------------------------------------------------------------

  async read(caller: MemoryCaller, bankId: string, opts: { entityTypes?: string[]; observationLimit?: number }): Promise<GraphRead> {
    const bank = await this.readable(caller, bankId);
    if (!bank) return EMPTY;
    const rows = await this.prisma.memoryEntity.findMany({
      where: { bankId: bank.id, ...(opts.entityTypes ? { entityType: { in: opts.entityTypes } } : {}) },
      orderBy: { position: 'asc' },
      take: this.maxEntities + 1,
      select: { id: true, name: true, entityType: true },
    });
    return this.assemble(bank, rows, opts.observationLimit, true);
  }

  /** A case-insensitive substring of an entity's name, its type or any of its observations, in stored order. */
  async search(caller: MemoryCaller, bankId: string, query: string, opts: { limit?: number; observationLimit?: number }): Promise<GraphRead> {
    const bank = await this.readable(caller, bankId);
    if (!bank) return EMPTY;
    const ceilingApplies = opts.limit === undefined || opts.limit > this.maxEntities;
    const take = ceilingApplies ? this.maxEntities + 1 : opts.limit!;
    const rows = await this.prisma.$queryRaw<EntityRow[]>`
      SELECT e.id, e.name, e.entity_type AS "entityType"
        FROM memory_entities e
       WHERE e.bank_id = ${bank.id}::uuid
         AND (strpos(lower(e.name), lower(${query})) > 0
              OR strpos(lower(e.entity_type), lower(${query})) > 0
              OR EXISTS (SELECT 1 FROM memory_units u
                          WHERE u.bank_id = e.bank_id AND u.fact_type <> 'observation'
                            AND u.document_id LIKE 'graph:' || e.id::text || ':%'
                            AND strpos(lower(u.text), lower(${query})) > 0))
       ORDER BY e.position
       LIMIT ${take}`;
    return this.assemble(bank, rows, opts.observationLimit, ceilingApplies);
  }

  /** Entities by exact name, in stored order; an unknown name is skipped. */
  async open(caller: MemoryCaller, bankId: string, names: string[], opts: { observationLimit?: number }): Promise<ReadGraph> {
    const bank = await this.readable(caller, bankId);
    if (!bank) return EMPTY.graph;
    const rows = await this.prisma.memoryEntity.findMany({ where: { bankId: bank.id, name: { in: names } }, orderBy: { position: 'asc' }, select: { id: true, name: true, entityType: true } });
    return (await this.assemble(bank, rows, opts.observationLimit, false)).graph;
  }

  // --- writes ------------------------------------------------------------

  /**
   * New entities with their observations. A name the bank holds, or one
   * earlier in the call, is skipped with its observations. The entity rows
   * go in first, so their ids name the observations; a store that fails
   * takes them back out.
   */
  async createEntities(caller: MemoryCaller, bankId: string, entities: GraphEntity[]): Promise<{ created: GraphEntity[]; skipped: string[] }> {
    assertGraphNames(entities.flatMap((e) => [e.name, e.entityType]));
    const existing = await this.access.find(caller, bankId);
    const taken = new Set(existing ? (await this.prisma.memoryEntity.findMany({ where: { bankId: existing.id, name: { in: entities.map((e) => e.name) } }, select: { name: true } })).map((r) => r.name) : []);
    const mask = createMasker();
    const planned = newInBatch(entities, (e) => e.name, taken).map((source) => {
      const entity = { name: source.name, entityType: source.entityType, observations: source.observations.map(mask) };
      const id = randomUUID();
      return { id, source, entity, items: entity.observations.map((content, i) => observationItem(mask, entity, content, observationDocumentId(id, i + 1))) };
    });
    const items = planned.flatMap((p) => p.items);
    const bank = await this.intake.admit(caller, bankId, items, { allowEmpty: true });
    await this.prisma.memoryEntity.createMany({
      data: planned.map((p) => ({
        id: p.id,
        workspaceId: caller.workspaceId,
        bankId: bank.id,
        name: p.entity.name,
        entityType: p.entity.entityType,
        entityKey: normalizeEntityKey(p.entity.name),
        observationSeq: p.items.length,
        createdBy: caller.principal.userId,
      })),
      skipDuplicates: true,
    });
    // A name another call created since the read above lost the race here: skipped, as if it had been there.
    const won = new Set((await this.prisma.memoryEntity.findMany({ where: { id: { in: planned.map((p) => p.id) } }, select: { id: true } })).map((r) => r.id));
    const created = planned.filter((p) => won.has(p.id));
    try {
      await this.intake.store(caller, bank, created.flatMap((p) => p.items), { verbatim: true });
    } catch (e) {
      await this.prisma.memoryEntity.deleteMany({ where: { id: { in: created.map((p) => p.id) } } });
      throw e;
    }
    const kept = new Set(created.map((p) => p.source));
    return { created: created.map((p) => p.entity), skipped: entities.filter((e) => !kept.has(e)).map((e) => e.name) };
  }

  /** New relations between entities that exist; one the bank holds, or one earlier in the call, is not added again. */
  async createRelations(caller: MemoryCaller, bankId: string, relations: GraphRelation[]): Promise<GraphRelation[]> {
    assertGraphNames(relations.map((r) => r.relationType));
    const bank = await this.access.find(caller, bankId);
    const byName = await this.entitiesNamed(bank, relations.flatMap((r) => [r.from, r.to]));
    for (const r of relations) {
      if (!byName.has(r.from)) throw entityNotFound(r.from);
      if (!byName.has(r.to)) throw entityNotFound(r.to);
    }
    await this.rate.check('retain', caller.principal);
    if (!bank || !relations.length) return [];
    const ids = (r: GraphRelation) => ({ fromId: byName.get(r.from)!.id, toId: byName.get(r.to)!.id, relationType: r.relationType });
    const held = await this.prisma.memoryRelation.findMany({
      where: { bankId: bank.id, OR: relations.map(ids) },
      select: { relationType: true, from: { select: { name: true } }, to: { select: { name: true } } },
    });
    const fresh = newInBatch(relations, relationKey, new Set(held.map((h) => relationKey({ from: h.from.name, to: h.to.name, relationType: h.relationType }))));
    await this.prisma.memoryRelation.createMany({
      data: fresh.map((r) => ({ ...ids(r), workspaceId: caller.workspaceId, bankId: bank.id, createdBy: caller.principal.userId })),
      skipDuplicates: true,
    });
    return fresh.map((r) => ({ from: r.from, to: r.to, relationType: r.relationType }));
  }

  /** Observations added to entities that exist; one the entity holds, or one repeated in the call, is not added again. */
  async addObservations(caller: MemoryCaller, bankId: string, groups: Array<{ entityName: string; contents: string[] }>): Promise<Array<{ entityName: string; addedObservations: string[] }>> {
    const bank = await this.access.find(caller, bankId);
    const byName = await this.entitiesNamed(bank, groups.map((g) => g.entityName));
    for (const g of groups) if (!byName.has(g.entityName)) throw entityNotFound(g.entityName);
    if (!bank || !groups.length) return [];

    const mask = createMasker();
    const masked = groups.map((g) => ({ entity: byName.get(g.entityName)!, contents: [...new Set(g.contents.map(mask))] }));
    // What each entity already holds of these texts: the only ones a duplicate can be.
    const held = await this.prisma.memoryUnit.findMany({
      where: { bankId: bank.id, ...FACTS, text: { in: [...new Set(masked.flatMap((m) => m.contents))] }, OR: [...new Set(masked.map((m) => m.entity.id))].map((id) => ({ documentId: { startsWith: observationPrefix(id) } })) },
      select: { documentId: true, text: true },
    });
    const has = new Map<string, Set<string>>();
    const holding = (entityId: string) => has.get(entityId) ?? has.set(entityId, new Set()).get(entityId)!;
    for (const h of held) holding(h.documentId.split(':')[1]!).add(h.text);
    // In call order, so a second group for one entity skips what the first added.
    const added = masked.map(({ entity, contents }) => {
      const mine = holding(entity.id);
      const fresh = contents.filter((c) => !mine.has(c));
      fresh.forEach((c) => mine.add(c));
      return { entity, fresh };
    });

    const drafts = added.flatMap((a) => a.fresh.map((content) => ({ content })));
    const admitted = await this.intake.admit(caller, bankId, drafts, { allowEmpty: true });
    const items: RetainItem[] = [];
    for (const [entityId, count] of countBy(added.flatMap((a) => a.fresh.map(() => a.entity.id)))) {
      const [row] = await this.prisma.$queryRaw<Array<{ seq: number }>>`
        UPDATE memory_entities SET observation_seq = observation_seq + ${count} WHERE id = ${entityId}::uuid RETURNING observation_seq AS seq`;
      const entity = added.find((a) => a.entity.id === entityId)!.entity;
      if (!row) throw entityNotFound(entity.name);
      let seq = row.seq - count;
      for (const a of added) if (a.entity.id === entityId) for (const content of a.fresh) items.push(observationItem(mask, entity, content, observationDocumentId(entityId, ++seq)));
    }
    await this.intake.store(caller, admitted, items, { verbatim: true });
    return added.map((a, i) => ({ entityName: groups[i]!.entityName, addedObservations: a.fresh }));
  }

  /** Entities by name, with their observations and every relation touching them. */
  async deleteEntities(caller: MemoryCaller, bankId: string, names: string[]): Promise<string> {
    const bank = await this.writable(caller, bankId);
    const rows = [...(await this.entitiesNamed(bank, names)).values()];
    const present = new Set(rows.map((r) => r.name));
    if (bank && rows.length) await this.removeEntities(bank, rows.map((r) => r.id));
    return deleteEntitiesMessage(names.length, names.filter((n) => present.has(n)).length, names.filter((n) => !present.has(n)));
  }

  /** Observations by exact text. A secret was stored as its placeholder, so quoting the secret matches nothing. */
  async deleteObservations(caller: MemoryCaller, bankId: string, deletions: Array<{ entityName: string; observations: string[] }>): Promise<string> {
    const bank = await this.writable(caller, bankId);
    const byName = await this.entitiesNamed(bank, deletions.map((d) => d.entityName));
    const requested = deletions.reduce((n, d) => n + d.observations.length, 0);
    const missing = deletions.filter((d) => !byName.has(d.entityName)).map((d) => d.entityName);
    const match = deletions.flatMap((d) => {
      const entity = byName.get(d.entityName);
      return entity && d.observations.length ? [{ documentId: { startsWith: observationPrefix(entity.id) }, text: { in: d.observations } }] : [];
    });
    const deleted = bank && match.length ? (await this.units.deleteWhere(bank, { ...FACTS, OR: match })).matched : 0;
    return deleteObservationsMessage(requested, deleted, missing);
  }

  /** Relations matched exactly on all three fields; the entities stay. */
  async deleteRelations(caller: MemoryCaller, bankId: string, relations: GraphRelation[]): Promise<string> {
    const bank = await this.writable(caller, bankId);
    const deleted =
      bank && relations.length
        ? await this.prisma.$executeRaw`
            DELETE FROM memory_relations r USING memory_entities f, memory_entities t
             WHERE r.bank_id = ${bank.id}::uuid AND f.id = r.from_id AND t.id = r.to_id
               AND (f.name, t.name, r.relation_type) IN (
                 SELECT * FROM unnest(${relations.map((r) => r.from)}::text[], ${relations.map((r) => r.to)}::text[], ${relations.map((r) => r.relationType)}::text[]))`
        : 0;
    return deleteRelationsMessage(relations.length, deleted);
  }

  /**
   * Entity rows with their observations; relations cascade with the rows.
   * The one entity delete, for the wire and the bank page alike. Answers how
   * many entity rows went.
   */
  async removeEntities(bank: MemoryBank, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    let removed = 0;
    // The observations are facts, deleted the way every fact is.
    await this.units.deleteWhere(bank, { ...FACTS, OR: ids.map((id) => ({ documentId: { startsWith: observationPrefix(id) } })) }, async () => {
      removed = (await this.prisma.memoryEntity.deleteMany({ where: { id: { in: ids }, bankId: bank.id } })).count;
    });
    return removed;
  }

  // --- helpers -----------------------------------------------------------

  private async readable(caller: MemoryCaller, bankId: string): Promise<MemoryBank | null> {
    const bank = await this.access.find(caller, bankId);
    await this.rate.check('recall', caller.principal);
    return bank;
  }

  /** A delete's bank: never created, since there is nothing in a missing one to delete. */
  private async writable(caller: MemoryCaller, bankId: string): Promise<MemoryBank | null> {
    const bank = await this.access.find(caller, bankId);
    await this.rate.check('retain', caller.principal);
    return bank;
  }

  private async entitiesNamed(bank: MemoryBank | null, names: string[]): Promise<Map<string, EntityRow>> {
    if (!bank || !names.length) return new Map();
    const rows = await this.prisma.memoryEntity.findMany({ where: { bankId: bank.id, name: { in: [...new Set(names)] } }, select: { id: true, name: true, entityType: true } });
    return new Map(rows.map((r) => [r.name, r]));
  }

  /** Entities with their observations, and the relations touching any of them. `rows` may hold one past the ceiling: that is how a cut is told. */
  private async assemble(bank: MemoryBank, rows: EntityRow[], observationLimit: number | undefined, ceilingApplies: boolean): Promise<GraphRead> {
    const capped = ceilingApplies && rows.length > this.maxEntities;
    const kept = capped ? rows.slice(0, this.maxEntities) : rows;
    if (!kept.length) return { graph: { entities: [], relations: [] }, capped };
    const ids = kept.map((r) => r.id);
    const [observed, relations] = await Promise.all([
      this.prisma.$queryRaw<Array<{ entityId: string; text: string; total: number }>>`
        SELECT entity_id AS "entityId", text, total::int AS total FROM (
          SELECT split_part(document_id, ':', 2) AS entity_id, text,
                 row_number() OVER (PARTITION BY split_part(document_id, ':', 2) ORDER BY document_id, id) AS n,
                 count(*) OVER (PARTITION BY split_part(document_id, ':', 2)) AS total
            FROM memory_units
           WHERE bank_id = ${bank.id}::uuid AND fact_type <> 'observation' AND document_id LIKE 'graph:%'
             AND split_part(document_id, ':', 2) = ANY(${ids}::text[])
        ) x
        -- One row even at a limit of 0: it carries the entity's total.
        WHERE n <= GREATEST(${observationLimit ?? 2_147_483_647}, 1)
        ORDER BY entity_id, n`,
      this.prisma.$queryRaw<GraphRelation[]>`
        SELECT f.name AS "from", t.name AS "to", r.relation_type AS "relationType"
          FROM memory_relations r
          JOIN memory_entities f ON f.id = r.from_id
          JOIN memory_entities t ON t.id = r.to_id
         WHERE r.bank_id = ${bank.id}::uuid AND (r.from_id = ANY(${ids}::uuid[]) OR r.to_id = ANY(${ids}::uuid[]))
         ORDER BY r.position`,
    ]);
    const byEntity = new Map<string, { texts: string[]; total: number }>();
    for (const o of observed) {
      const held = byEntity.get(o.entityId) ?? byEntity.set(o.entityId, { texts: [], total: o.total }).get(o.entityId)!;
      held.texts.push(o.text);
    }
    return { graph: { entities: readEntities(kept, byEntity, observationLimit), relations }, capped };
  }
}

/**
 * One observation as a retain item: stored verbatim, linked to its entity by
 * the folded name so recall's entity leg finds it, and with the entity as its
 * context so the embedding knows whom it is about.
 */
function observationItem(mask: (text: string) => string, entity: { name: string; entityType: string }, content: string, documentId: string): RetainItem {
  return {
    content,
    context: mask(`${entity.name} (${entity.entityType})`),
    timestamp: new Date().toISOString(),
    metadata: {},
    documentId,
    entities: [{ name: entity.name, key: normalizeEntityKey(entity.name) }],
    tags: [],
    append: false,
  };
}

function countBy(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}
