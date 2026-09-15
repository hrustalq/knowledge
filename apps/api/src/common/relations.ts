import { isAuthorableRelationType } from '@knowledge/contracts';
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

/** `service:identity` → name `identity`, so a vertex is legible in the graph view. */
function entityNameOf(key: string): string {
  return key.split(':').pop() ?? key;
}

/** Accepts both shapes the frontmatter contract allows: `"service:billing"` or `{type,key,name}`. */
export function normalizeRelationTarget(target: unknown): FrontmatterRelation['target'] | null {
  if (typeof target === 'string' && target.trim()) {
    const key = target.trim();
    return { key, type: entityTypeOf(key), name: entityNameOf(key) };
  }
  if (target && typeof target === 'object') {
    const t = target as { type?: unknown; key?: unknown; name?: unknown };
    if (typeof t.key !== 'string' || !t.key.trim()) return null;
    const key = t.key.trim();
    return {
      key,
      type: typeof t.type === 'string' && t.type.trim() ? t.type.trim() : entityTypeOf(key),
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : entityNameOf(key),
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
  const { type, target } = value as { type?: unknown; target?: unknown };
  if (typeof type !== 'string' || !isAuthorableRelationType(type)) return null;
  const normalized = normalizeRelationTarget(target);
  return normalized ? { type, target: normalized } : null;
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
  const raw = frontmatter?.relations;
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
  const raw = frontmatter?.tags;
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== 'string' || !tag.trim()) continue;
    const trimmed = tag.trim();
    if (!tags.includes(trimmed)) tags.push(trimmed);
  }
  return tags;
}
