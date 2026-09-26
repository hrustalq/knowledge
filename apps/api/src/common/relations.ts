import {
  FRONTMATTER_KEY_ALIASES,
  normalizeEntityKey,
  normalizeRelationType,
} from '@knowledge/contracts';
import type { AuthorableRelationType } from '@knowledge/contracts';

/**
 * The frontmatter spelling of a relation, and the one normalizer for it.
 *
 * Both directions of the same vocabulary meet here. The ingestion worker parses
 * `relations:` out of a page; the relations service and the workflow executors
 * write them back. Before this existed only the read direction had a normalizer,
 * so the first writer to appear would have had to invent a second one — which is
 * exactly how the seven copies of the type list came about.
 *
 * A leaf module with no Nest imports, because the worker-side executors need it
 * as much as the API does.
 */

export interface FrontmatterRelation {
  /** Guaranteed authorable: `normalizeRelation` is the only way to build one. */
  type: AuthorableRelationType;
  target: { type: string; key: string; name: string };
}

/** `service:identity` → type `service`; a bare key is a plain entity. */
function entityTypeOf(key: string): string {
  return key.includes(':') ? key.slice(0, key.indexOf(':')) : 'entity';
}

/**
 * The label a vertex shows, taken from what the author actually typed.
 *
 * Deliberately not folded: `normalizeEntityKey` lowercases so that the graph
 * uniques correctly, and a graph view full of `сервис:биллинг` in lower case
 * would be the cost of that. Identity is folded, display is not.
 */
function displayNameOf(raw: string): string {
  const trimmed = raw.normalize('NFC').trim();
  const colon = trimmed.lastIndexOf(':');
  const tail = (colon === -1 ? trimmed : trimmed.slice(colon + 1)).trim();
  return tail || trimmed;
}

/** A key that folded away to punctuation is not a key. */
function hasContent(key: string): boolean {
  return /[\p{L}\p{N}]/u.test(key);
}

/** Accepts both shapes the frontmatter contract allows: `"service:billing"` or `{type,key,name}`. */
export function normalizeRelationTarget(target: unknown): FrontmatterRelation['target'] | null {
  if (typeof target === 'string' && target.trim()) {
    const key = normalizeEntityKey(target);
    if (!hasContent(key)) return null;
    return { key, type: entityTypeOf(key), name: displayNameOf(target) };
  }
  if (target && typeof target === 'object') {
    const t = target as { type?: unknown; key?: unknown; name?: unknown };
    if (typeof t.key !== 'string' || !t.key.trim()) return null;
    const key = normalizeEntityKey(t.key);
    if (!hasContent(key)) return null;
    return {
      key,
      type:
        typeof t.type === 'string' && t.type.trim()
          ? t.type.normalize('NFC').trim().toLowerCase()
          : entityTypeOf(key),
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : displayNameOf(t.key),
    };
  }
  return null;
}

/**
 * One relation, or null when it is not one. An unknown edge type is dropped
 * rather than coerced: `GraphService.assertEdgeType` throws on it, and by then
 * the caller is a materialize step that a person already approved.
 */
export function normalizeRelation(value: unknown): FrontmatterRelation | null {
  if (!value || typeof value !== 'object') return null;
  const { type, target, targetKey, name } = value as {
    type?: unknown;
    target?: unknown;
    targetKey?: unknown;
    name?: unknown;
  };
  if (typeof type !== 'string') return null;
  const canonicalType = normalizeRelationType(type);
  if (!canonicalType) return null;
  // `targetKey:` (+ a sibling `name:`) is the spelling every tool schema and
  // fact listing uses, so it is what agents write back into frontmatter. Reading
  // only `target:` dropped those relations at ingestion with no error.
  const normalized = normalizeRelationTarget(
    target ?? (typeof targetKey === 'string' ? { key: targetKey, ...(typeof name === 'string' ? { name } : {}) } : undefined),
  );
  return normalized ? { type: canonicalType, target: normalized } : null;
}

/**
 * The value of a frontmatter key under any spelling this workspace accepts.
 *
 * The canonical English key wins when a page carries both, so a document with
 * `relations:` and `связи:` resolves the same way on every re-index rather than
 * depending on YAML key order.
 */
function aliasedValue(
  frontmatter: Record<string, unknown> | null | undefined,
  canonical: 'relations' | 'tags',
): unknown {
  if (!frontmatter) return undefined;
  if (frontmatter[canonical] !== undefined) return frontmatter[canonical];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (FRONTMATTER_KEY_ALIASES[key.normalize('NFC').trim().toLowerCase()] === canonical) {
      return value;
    }
  }
  return undefined;
}

/** Identity of a relation for de-duplication: the pair the graph uniques on. */
export function relationKey(relation: { type: string; target: { key: string } }): string {
  return `${relation.type} ${relation.target.key}`;
}

export function dedupeRelations(relations: FrontmatterRelation[]): FrontmatterRelation[] {
  const seen = new Set<string>();
  return relations.filter((relation) => {
    const key = relationKey(relation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Valid, de-duplicated relations declared in a page's frontmatter. */
export function readFrontmatterRelations(
  frontmatter: Record<string, unknown> | null | undefined,
): FrontmatterRelation[] {
  const raw = aliasedValue(frontmatter, 'relations');
  if (!Array.isArray(raw)) return [];
  const parsed: FrontmatterRelation[] = [];
  for (const entry of raw) {
    const relation = normalizeRelation(entry);
    if (relation) parsed.push(relation);
  }
  return dedupeRelations(parsed);
}

export function readFrontmatterTags(
  frontmatter: Record<string, unknown> | null | undefined,
): string[] {
  const raw = aliasedValue(frontmatter, 'tags');
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  // Dedupe on the canonical form but keep the spelling the author used: a page
  // tagged both `Безопасность` and `безопасность` is carrying one tag twice,
  // and used to produce two vertices and two unrelated filter results.
  const seen = new Set<string>();
  for (const tag of raw) {
    if (typeof tag !== 'string' || !tag.trim()) continue;
    const trimmed = tag.normalize('NFC').trim();
    const canonical = normalizeEntityKey(trimmed);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    tags.push(trimmed);
  }
  return tags;
}

/** The canonical `tag:<name>` entity key for a tag, however it was spelled. */
export function tagEntityKey(tag: string): string {
  return `tag:${normalizeEntityKey(tag)}`;
}

/**
 * The same key, from a filter value that may already carry the prefix.
 *
 * The read side has to fold exactly as the write side did or the filter misses:
 * a page tagged `безопасность` was invisible to a reader who typed
 * `Безопасность`, and the empty result looked like an absence of pages rather
 * than a casing difference.
 */
export function tagFilterKey(input: string): string {
  const key = normalizeEntityKey(input);
  return key.startsWith('tag:') ? key : `tag:${key}`;
}
