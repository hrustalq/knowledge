/**
 * A page's own fields in a shared draft (#80): the `meta` map beside the body.
 *
 * Both sides seed it: the API when it creates a draft from the branch head,
 * the editor for a draft that predates server seeding. One function, so the
 * two cannot disagree about which field is free text and which is a value —
 * and a draft the server seeded opens with nothing to write, so opening a page
 * is never itself an unpublished change.
 */
import * as Y from 'yjs';

/** The page's own fields in the draft, beside its body. */
export const META_FIELD = 'meta';

export interface RelationRow {
  type: string;
  key: string;
  name: string;
}

/** What `meta` holds: free text as Y.Text (two people can type in one), the rest last-writer-wins. */
export interface PageMeta {
  texts: { title: string; tags: string; message: string };
  values: { category: string; parentId: string; projectId: string; relations: RelationRow[] };
}

/** The frontmatter keys the settings sheet models. Everything else is carried verbatim. */
const MODELLED_KEYS = new Set(['relations', 'tags']);

/** Split parsed frontmatter into the rows the settings sheet edits and the keys it only carries. */
export function readFrontmatter(frontmatter: Record<string, unknown> | null | undefined): {
  relations: RelationRow[];
  tags: string;
  other: Record<string, unknown>;
} {
  const fm = frontmatter ?? {};
  const other = Object.fromEntries(Object.entries(fm).filter(([key]) => !MODELLED_KEYS.has(key)));
  const relations = Array.isArray(fm.relations)
    ? (fm.relations as Array<Record<string, unknown>>)
        .map((r): RelationRow | null => {
          const target = r.target;
          if (typeof target === 'string') return { type: String(r.type ?? ''), key: target, name: '' };
          if (target && typeof target === 'object') {
            const t = target as Record<string, unknown>;
            return { type: String(r.type ?? ''), key: String(t.key ?? ''), name: String(t.name ?? '') };
          }
          return null;
        })
        .filter((r): r is RelationRow => r !== null && !!r.type && !!r.key)
    : [];
  const tags = Array.isArray(fm.tags) ? (fm.tags as unknown[]).map(String).join(', ') : '';
  return { relations, tags, other };
}

/** The published page's fields, the way the editor loads them. */
export function pageMetaOf(
  page: { title: string; category: string; parentId: string | null; projectId: string },
  frontmatter: Record<string, unknown> | null | undefined,
): PageMeta {
  const { relations, tags } = readFrontmatter(frontmatter);
  return {
    texts: { title: page.title, tags, message: '' },
    values: { category: page.category, parentId: page.parentId ?? '', projectId: page.projectId, relations },
  };
}

/**
 * Write every field `meta` does not hold yet. `set` of a fresh Y.Text under a
 * key is one map write, so two seeds at once keep one value, not two copies.
 */
export function seedPageMeta(
  doc: Y.Doc,
  fields: { texts: Record<string, string>; values: Record<string, unknown> },
): void {
  const meta = doc.getMap<unknown>(META_FIELD);
  doc.transact(() => {
    for (const [key, text] of Object.entries(fields.texts)) {
      if (!(meta.get(key) instanceof Y.Text)) meta.set(key, new Y.Text(text));
    }
    for (const [key, value] of Object.entries(fields.values)) {
      if (!meta.has(key)) meta.set(key, JSON.parse(JSON.stringify(value ?? null)));
    }
  });
}

/** The page fields a draft holds now: what `seedPageMeta` wrote, as peers have edited it since. */
export function readPageMeta(doc: Y.Doc): PageMeta {
  const meta = doc.getMap<unknown>(META_FIELD);
  const text = (key: string) => meta.get(key)?.toString() ?? '';
  const value = <T>(key: string, fallback: T) => (meta.get(key) as T | undefined) ?? fallback;
  return {
    texts: { title: text('title'), tags: text('tags'), message: text('message') },
    values: {
      category: value('category', ''),
      parentId: value('parentId', ''),
      projectId: value('projectId', ''),
      relations: value<RelationRow[]>('relations', []),
    },
  };
}
