import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { wrapUntrusted } from '../common/untrusted.js';
import { t } from '../i18n/t.js';

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

/** Sorted and deduplicated, so two orders of one set are stored — and compared — as one array. */
export const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? [...new Set(tags.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 100)))].sort().slice(0, MAX_TAGS) : [];

const cleanNames = (names: unknown[]): string[] =>
  [...new Set(names.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, MAX_ENTITY_CHARS)).filter(Boolean))].slice(0, MAX_ENTITIES);

const dateOf = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

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
  if (items.length < 1 || items.length > limits.maxItems) throw new BadRequestException(t('error.memory.itemsRequired', { max: limits.maxItems }));
  const shared = items.some((i) => typeof i.document_id === 'string' && i.document_id) ? null : randomUUID();
  const extraTags = cleanTags(documentTags);
  return items.map((item) => {
    if (typeof item.content !== 'string' || !item.content.trim()) throw new BadRequestException(t('error.memory.contentNotText'));
    if (item.content.length > limits.maxChars) throw new BadRequestException(t('error.memory.itemTooLong', { max: limits.maxChars }));
    let timestamp: string | null = now.toISOString();
    if (item.timestamp === 'unset') timestamp = null;
    else if (item.timestamp != null) {
      const parsed = dateOf(item.timestamp);
      if (!parsed) throw new BadRequestException(t('error.memory.timestampInvalid'));
      timestamp = parsed.toISOString();
    }
    const metadata = item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata) ? item.metadata : {};
    const entities = Array.isArray(item.entities) ? item.entities : [];
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
      tags: cleanTags([...(Array.isArray(item.tags) ? item.tags : []), ...extraTags]),
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

/** The user message of one extraction call: each item under its label, wrapped untrusted. */
export function extractionPrompt(items: ReadonlyArray<{ content: string; context: string | null }>, mission: string): string {
  const body = items.map((item, i) => `I${i + 1}${item.context ? ` (context: ${item.context})` : ''}:\n${item.content}`).join('\n\n');
  return `${mission ? `What this memory bank is for: ${mission}\n\n` : ''}Items:\n${wrapUntrusted(body, 'retain', 'memory')}`;
}

/**
 * The model's answer, reduced to what it may say: facts under a label that was
 * handed out, each a non-empty sentence of a known type. Anything else is
 * dropped, and an item left with no fact is the caller's to store verbatim.
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
    if (facts.length) out.set(index, facts);
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
