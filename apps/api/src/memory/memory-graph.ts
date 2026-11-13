import { BadRequestException } from '@nestjs/common';

/**
 * The pure half of a bank's graph wire (#1008): the MCP reference memory
 * server's (`@modelcontextprotocol/server-memory` 2.1.1) rules and strings,
 * with no store. Every string an agent reads here is the reference's, word
 * for word: a client set up for that server must not see a difference.
 */

export interface GraphEntity {
  name: string;
  entityType: string;
  observations: string[];
}

/** An entity in a read tool's result: `observationCount` only when the call gave `observationLimit`. */
export interface ReadEntity extends GraphEntity {
  observationCount?: number;
}

export interface GraphRelation {
  from: string;
  to: string;
  relationType: string;
}

export interface ReadGraph {
  entities: ReadEntity[];
  relations: GraphRelation[];
}

/**
 * Longest name, entity type or relation type stored. The reference has none;
 * here each is a unique-index key, and a btree key has a size limit. A
 * documented difference.
 */
export const MAX_GRAPH_NAME_CHARS = 500;

/** An observation's `memory_units.document_id`: its entity's row and its number there, padded so the text order is the order added. */
export const observationDocumentId = (entityId: string, seq: number) => `graph:${entityId}:${String(seq).padStart(10, '0')}`;
/** What every observation document id of one entity starts with. */
export const observationPrefix = (entityId: string) => `graph:${entityId}:`;

/** The first occurrence of each key that is not already taken: the reference's batch dedupe, against the store and earlier in the same call. */
export function newInBatch<T>(items: readonly T[], keyOf: (item: T) => string, taken: ReadonlySet<string>): T[] {
  const seen = new Set(taken);
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One string key per relation, for dedupe and lookups. */
export const relationKey = (r: GraphRelation) => JSON.stringify([r.from, r.to, r.relationType]);

/** Refuses a name or a type too long to store, before anything is written. */
export function assertGraphNames(values: Iterable<string>): void {
  for (const value of values) {
    if (value.length > MAX_GRAPH_NAME_CHARS) throw new BadRequestException(`Names and types are limited to ${MAX_GRAPH_NAME_CHARS} characters on this server`);
  }
}

/** The reference's `Entity with name X not found`, thrown as a plain error: the MCP SDK turns its message into the tool's error text. */
export const entityNotFound = (name: string) => new Error(`Entity with name ${name} not found`);

export function skippedEntitiesNotice(skipped: readonly string[]): string {
  const one = skipped.length === 1;
  return (
    `Skipped ${skipped.length} ${one ? 'entity that already exists' : 'entities that already exist'}: ` +
    `${skipped.join(', ')}. ${one ? 'Its' : 'Their'} observations were not added; ` +
    'use add_observations for existing entities.'
  );
}

export function deleteEntitiesMessage(requested: number, deleted: number, notFound: readonly string[]): string {
  return notFound.length === 0 ? 'Entities deleted successfully' : `Deleted ${deleted} of ${requested} entities. Not found: ${notFound.join(', ')}`;
}

export function deleteObservationsMessage(requested: number, deleted: number, missingEntities: readonly string[]): string {
  return deleted === requested
    ? 'Observations deleted successfully'
    : `Deleted ${deleted} of ${requested} observations.` + (missingEntities.length ? ` Entities not found: ${missingEntities.join(', ')}` : '');
}

export function deleteRelationsMessage(requested: number, deleted: number): string {
  return deleted === requested ? 'Relations deleted successfully' : `Deleted ${deleted} of ${requested} relations. The rest matched nothing.`;
}

/**
 * Said beside a read this server cut short (the reference never does: it
 * has no ceiling). A second text block, as the reference adds its own
 * notices, so the JSON and `structuredContent` keep their shape.
 */
export const ceilingNotice = (max: number) =>
  `Showing only the first ${max} entities: this server returns at most ${max} per call. ` +
  'Narrow it with entityTypes or observationLimit, search_nodes with a query, or open_nodes with names.';

/** A tool result as the reference returns one: the value as indented JSON, and as `structuredContent`. */
export function graphToolResult<T extends object>(value: T, notices: string[] = []) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }, ...notices.map((text) => ({ type: 'text' as const, text }))],
    structuredContent: { ...value } as Record<string, unknown>,
  };
}

/** A delete's result: the message, as text and as `{ success, message }`. */
export const messageToolResult = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  structuredContent: { success: true, message } as Record<string, unknown>,
});

/**
 * Entities in stored order with their observations, reduced as the reference
 * does: `observationLimit` keeps the first ones and adds `observationCount`.
 * `observations` holds, by entity id, every observation in the order added
 * (or the first `limit` of them) and the entity's total.
 */
export function readEntities(
  rows: ReadonlyArray<{ id: string; name: string; entityType: string }>,
  observations: ReadonlyMap<string, { texts: string[]; total: number }>,
  observationLimit: number | undefined,
): ReadEntity[] {
  return rows.map((row) => {
    const held = observations.get(row.id) ?? { texts: [], total: 0 };
    const base = { name: row.name, entityType: row.entityType, observations: observationLimit === undefined ? held.texts : held.texts.slice(0, observationLimit) };
    return observationLimit === undefined ? base : { ...base, observationCount: held.total };
  });
}
