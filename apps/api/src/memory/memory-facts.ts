import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { wrapUntrusted } from '../common/untrusted.js';
import { t } from '../i18n/t.js';
import { FILE_DOCUMENT_PREFIX } from './memory-files.js';
import { globMatch } from './memory-observations.js';

/**
 * The pure half of retain (#986): reading a request into items, building the
 * extraction prompt, and reading the model's answer back. No model, no store.
 */

export const FACT_TYPES = ['world', 'experience'] as const;
export type FactType = (typeof FACT_TYPES)[number];
export const TAGS_MATCH = ['any', 'all', 'any_strict', 'all_strict', 'exact'] as const;
export type TagsMatch = (typeof TAGS_MATCH)[number];
/** The time axes `memories/list` filters and orders by, as `memory_units` fields. */
export const MEMORY_TIME_FIELDS = { created_at: 'createdAt', updated_at: 'updatedAt', mentioned_at: 'mentionedAt', occurred_start: 'occurredStart', occurred_end: 'occurredEnd' } as const;
export type MemoryTimeField = keyof typeof MEMORY_TIME_FIELDS;

/** One item of a retain request, validated and with its defaults settled. JSON-safe: it rides in an async operation's row. */
export interface RetainItem {
  content: string;
  context: string | null;
  /** ISO, or null for "unset": the item is timeless. */
  timestamp: string | null;
  metadata: Record<string, string>;
  documentId: string;
  /** Entities the client supplied: the name as written, and the key to fold — `type:name` when it gave a type. */
  entities: Array<{ name: string; key: string }>;
  tags: string[];
  /** The retain-time Hindsight observation_scopes value; undefined is combined. */
  observationScopes?: ObservationScopes;
  append: boolean;
}

export interface Fact {
  text: string;
  type: FactType;
  entities: string[];
  occurredStart: Date | null;
  occurredEnd: Date | null;
}

const MAX_FACTS_PER_ITEM = 30;
const MAX_FACT_CHARS = 2000;
const MAX_ENTITIES = 20;
const MAX_ENTITY_CHARS = 120;
const MAX_TAGS = 50;
const MAX_OBSERVATION_SCOPES = 100;
const OBSERVATION_SCOPE_MODES = ['combined', 'shared', 'per_tag', 'all_combinations'] as const;
export type ObservationScopes = (typeof OBSERVATION_SCOPE_MODES)[number] | string[][];

/** Sorted and deduplicated, so two orders of one set are stored — and compared — as one array. */
export const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? [...new Set(tags.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 100)))].sort().slice(0, MAX_TAGS) : [];

export function readObservationScopes(value: unknown): ObservationScopes | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' && (OBSERVATION_SCOPE_MODES as readonly string[]).includes(value)) return value as ObservationScopes;
  if (Array.isArray(value) && value.every((scope) => Array.isArray(scope) && scope.every((tag) => typeof tag === 'string'))) {
    return value.map((scope) => cleanTags(scope));
  }
  throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'observation_scopes', type: 'combined, shared, per_tag, all_combinations, or a list of string tag lists' }));
}

/** Exact, canonical tag sets a memory joins. Custom entries may use `*` against the memory's own tags. */
export function resolveObservationScopes(tags: string[], requested?: ObservationScopes): string[][] {
  const own = cleanTags(tags);
  const spec = requested ?? 'combined';
  let scopes: string[][];
  if (spec === 'combined') scopes = [own];
  else if (spec === 'shared') scopes = [[]];
  else if (spec === 'per_tag') scopes = own.map((tag) => [tag]);
  else if (spec === 'all_combinations') {
    scopes = [];
    for (let mask = 1; mask < 2 ** own.length; mask++) {
      scopes.push(own.filter((_, i) => mask & (1 << i)));
      if (scopes.length > MAX_OBSERVATION_SCOPES) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'observation_scopes', type: `at most ${MAX_OBSERVATION_SCOPES} resolved scopes` }));
    }
  } else {
    scopes = spec.flatMap((patterns) => {
      const matches = patterns.map((pattern) => {
        if (!pattern.includes('*')) return [pattern];
        return own.filter((tag) => globMatch(pattern, tag));
      });
      if (matches.some((m) => !m.length)) return [];
      return matches.reduce<string[][]>((sets, tagsForPattern) => {
        if (sets.length * tagsForPattern.length > MAX_OBSERVATION_SCOPES) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'observation_scopes', type: `at most ${MAX_OBSERVATION_SCOPES} resolved scopes` }));
        return sets.flatMap((set) => tagsForPattern.map((tag) => [...set, tag]));
      }, [[]]);
    });
  }
  // An untagged memory has no tag to split by: it joins the untagged scope, as `combined` would, rather than none.
  if (!own.length && (spec === 'per_tag' || spec === 'all_combinations')) scopes = [[]];
  const unique = [...new Map(scopes.map((scope) => [JSON.stringify(cleanTags(scope)), cleanTags(scope)])).values()];
  if (unique.length > MAX_OBSERVATION_SCOPES) throw new BadRequestException(t('error.memory.configValueInvalid', { key: 'observation_scopes', type: `at most ${MAX_OBSERVATION_SCOPES} resolved scopes` }));
  return unique;
}

const cleanNames = (names: unknown[]): string[] =>
  [...new Set(names.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, MAX_ENTITY_CHARS)).filter(Boolean))].slice(0, MAX_ENTITIES);

const dateOf = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** A retain request's ceilings, whichever wire built its items: how many items, and how long each one's text. */
export function assertRetainCeilings(items: ReadonlyArray<{ content?: unknown }>, limits: { maxItems: number; maxChars: number }): void {
  if (items.length < 1 || items.length > limits.maxItems) throw new BadRequestException(t('error.memory.itemsRequired', { max: limits.maxItems }));
  if (items.some((i) => typeof i.content === 'string' && i.content.length > limits.maxChars)) throw new BadRequestException(t('error.memory.itemTooLong', { max: limits.maxChars }));
}

/** Document ids only a wire writes: graph observations (`memory-graph.ts`) and a file's recall chunks (`FILE_DOCUMENT_PREFIX`). */
const RESERVED_DOCUMENT_PREFIXES = ['graph:', FILE_DOCUMENT_PREFIX] as const;
/** A document the graph or files wire owns: never retained, edited, deleted or transferred through the Hindsight document routes. */
export const isWireDocumentId = (documentId: string): boolean => RESERVED_DOCUMENT_PREFIXES.some((p) => documentId.startsWith(p));

/**
 * A retain body's items, as this server stores them. The global pipe checked
 * the envelope; what it cannot say is checked here: only text is retained, a
 * request and an item have ceilings, and a timestamp is a date or `unset`.
 *
 * `document_id`, as Hindsight assigns it: with none in the request, every item
 * shares one generated id; otherwise each item without one gets its own.
 */
export function readRetainItems(
  items: ReadonlyArray<Record<string, unknown>>,
  documentTags: unknown,
  limits: { maxItems: number; maxChars: number },
  now = new Date(),
): RetainItem[] {
  assertRetainCeilings(items, limits);
  const shared = items.some((i) => typeof i.document_id === 'string' && i.document_id) ? null : randomUUID();
  const extraTags = cleanTags(documentTags);
  return items.map((item) => {
    if (typeof item.content !== 'string' || !item.content.trim()) throw new BadRequestException(t('error.memory.contentNotText'));
    // The graph and files wires own these ids: a retain under one would replace their rows (#1108).
    if (typeof item.document_id === 'string' && RESERVED_DOCUMENT_PREFIXES.some((p) => (item.document_id as string).startsWith(p))) {
      throw new BadRequestException(t('error.memory.documentIdReserved'));
    }
    let timestamp: string | null = now.toISOString();
    if (item.timestamp === 'unset') timestamp = null;
    else if (item.timestamp != null) {
      const parsed = dateOf(item.timestamp);
      if (!parsed) throw new BadRequestException(t('error.memory.timestampInvalid'));
      timestamp = parsed.toISOString();
    }
    const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {};
    const entities = Array.isArray(item.entities) ? item.entities : [];
    const tags = cleanTags([...(Array.isArray(item.tags) ? item.tags : []), ...extraTags]);
    const observationScopes = readObservationScopes(item.observation_scopes);
    resolveObservationScopes(tags, observationScopes);
    return {
      content: item.content,
      context: typeof item.context === 'string' && item.context.trim() ? item.context.slice(0, 2000) : null,
      timestamp,
      metadata: Object.fromEntries(Object.entries(metadata).slice(0, 50).map(([k, v]) => [k.slice(0, 100), String(v).slice(0, 2000)])),
      documentId: typeof item.document_id === 'string' && item.document_id ? item.document_id.slice(0, 500) : (shared ?? randomUUID()),
      entities: entities.slice(0, MAX_ENTITIES).flatMap((e: { text?: unknown; type?: unknown } | null) => {
        const name = typeof e?.text === 'string' ? e.text.trim().slice(0, MAX_ENTITY_CHARS) : '';
        if (!name) return [];
        return [{ name, key: typeof e?.type === 'string' && e.type.trim() ? `${e.type.trim().slice(0, 40)}:${name}` : name }];
      }),
      tags,
      observationScopes,
      append: item.update_mode === 'append',
    };
  });
}

/** Items grouped so each extraction call stays under `maxChars` of retained text: as few calls as fit. */
export function extractionBatches<T extends { content: string }>(items: T[], maxChars: number): T[][] {
  const batches: T[][] = [];
  let size = 0;
  for (const item of items) {
    const last = batches.at(-1);
    if (last && size + item.content.length <= maxChars) {
      last.push(item);
      size += item.content.length;
    } else {
      batches.push([item]);
      size = item.content.length;
    }
  }
  return batches;
}

/** Under `durable` (#1169): the memorist drops non-durable facts within an item, not only whole items of chatter. */
export const DURABLE_ONLY_RULE =
  'Keep only durable facts: preferences, decisions, requirements, constraints, conventions and lessons that will still ' +
  'hold next time. Drop transient status, progress reports, one-off results and pleasantries, even when the same item ' +
  'also states a durable fact. An item with no durable fact gets an empty facts array.';

/** The user message of one extraction call: each item under its label, wrapped untrusted. */
export function extractionPrompt(items: ReadonlyArray<{ content: string; context: string | null }>, mission: string, durableOnly = false): string {
  const body = items.map((item, i) => `I${i + 1}${item.context ? ` (context: ${item.context})` : ''}:\n${item.content}`).join('\n\n');
  return `${mission ? `What this memory bank is for: ${mission}\n\n` : ''}${durableOnly ? `${DURABLE_ONLY_RULE}\n\n` : ''}Items:\n${wrapUntrusted(body, 'retain', 'memory')}`;
}

/**
 * The model's answer, reduced to what it may say: facts under a label that was
 * handed out, each a non-empty sentence of a known type. Anything else is
 * dropped. An explicit empty list means intentional no-facts; an item absent
 * from the map is an extraction failure the caller stores verbatim.
 */
export function readFacts(raw: unknown, count: number): Map<number, Fact[]> {
  const out = new Map<number, Fact[]>();
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return out;
  for (const entry of items as Array<{ item?: unknown; facts?: unknown } | null>) {
    const label = typeof entry?.item === 'string' ? /^I(\d+)$/.exec(entry.item.trim()) : null;
    const index = label ? Number(label[1]) - 1 : -1;
    if (index < 0 || index >= count || out.has(index) || !Array.isArray(entry?.facts)) continue;
    const facts: Fact[] = [];
    for (const f of entry.facts as Array<Record<string, unknown> | null>) {
      const text = typeof f?.text === 'string' ? f.text.trim().slice(0, MAX_FACT_CHARS) : '';
      if (!text || facts.length >= MAX_FACTS_PER_ITEM) continue;
      facts.push({
        text,
        type: FACT_TYPES.includes(f?.type as FactType) ? (f!.type as FactType) : 'world',
        entities: cleanNames(Array.isArray(f?.entities) ? f.entities : []),
        occurredStart: dateOf(f?.occurred_start),
        occurredEnd: dateOf(f?.occurred_end),
      });
    }
    if (facts.length || entry.facts.length === 0) out.set(index, facts);
  }
  return out;
}

/**
 * Hindsight's tag filter as a `memory_units` predicate. `any` and `all` also
 * return untagged memories; the `_strict` forms and `exact` do not. No tags is
 * no filter.
 */
export function tagsWhere(tags: string[] | undefined, match: TagsMatch = 'any'): Prisma.MemoryUnitWhereInput {
  const wanted = cleanTags(tags);
  if (!wanted.length) return {};
  if (match === 'exact') return { tags: { equals: wanted } };
  const hit: Prisma.MemoryUnitWhereInput = { tags: match.startsWith('all') ? { hasEvery: wanted } : { hasSome: wanted } };
  return match.endsWith('_strict') ? hit : { OR: [hit, { tags: { isEmpty: true } }] };
}
