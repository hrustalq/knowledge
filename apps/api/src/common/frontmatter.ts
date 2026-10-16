import matter from 'gray-matter';

/**
 * Reading and rewriting a markdown page's frontmatter.
 *
 * A leaf module on purpose, for `connector-markdown.ts`'s reason: the workflow
 * materializer, the relations service and the worker's executors all need to put
 * a YAML block back on a page, and none of them should have to import a provider
 * to do it. Nothing here touches Nest, storage or the database.
 *
 * Why this exists at all: frontmatter was, until now, only ever *read* on the
 * write path. `ingestion.processor` parses `relations:`/`tags:` into graph edges,
 * but nothing in the revision pipeline could put a key back — so the one caller
 * that tried (`workflow-materializer`) hand-rolled YAML and gave up entirely when
 * the page already had a frontmatter block, silently discarding it.
 *
 * Round-trip caveat: `matter.stringify` re-serializes through js-yaml. Keys and
 * values survive; comments, quoting style, anchors and block scalars do not. A
 * rewrite therefore shows some incidental reformatting in a diff. That is
 * accepted deliberately — the alternative is splicing text ranges, which trades
 * a cosmetic diff for a parser that can corrupt a page.
 */

export interface ParsedMarkdown {
  /** Parsed frontmatter; empty when the page has none. */
  data: Record<string, unknown>;
  /** The body, frontmatter removed. */
  body: string;
}

export function parseMarkdown(raw: string): ParsedMarkdown {
  const parsed = matter(raw);
  return {
    data: (parsed.data ?? {}) as Record<string, unknown>,
    body: parsed.content,
  };
}

/**
 * Merge `patch` into the page's frontmatter, preserving every key it does not
 * name — which is the whole point: a caller that edits `relations:` must not
 * disturb `source:`, `glossary:` or anything else a page carries.
 *
 * A key whose patch value is `undefined` is removed. When nothing is left, the
 * block is dropped rather than written empty.
 */
/**
 * Build a source document from a body and a complete frontmatter object.
 *
 * Use this when the caller already holds the parsed frontmatter — as every
 * reader of `DocumentsService.getContent` does, since that splits the two — and
 * so would otherwise have to re-serialize just to re-parse.
 */
export function composeFrontmatter(body: string, data: Record<string, unknown>): string {
  const present = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return Object.keys(present).length > 0 ? matter.stringify(body, present) : body;
}

/**
 * The page an agent submits as a full revision, with the base revision's
 * frontmatter put back when the agent sent a bare body.
 *
 * Every read an agent gets (`getContent`) hands it the body with the block split
 * off, and every write asks for "the complete markdown" — so posting back what it
 * read silently deleted the page's `relations:` and `tags:`, and with them its
 * graph edges. A submission that carries its own block, even an empty
 * `---\n---`, is taken as written: that is how an agent changes or clears it.
 */
export function keepFrontmatter(next: string, base: Record<string, unknown> | null | undefined): string {
  if (!base || Object.keys(base).length === 0 || matter.test(next)) return next;
  return composeFrontmatter(next, base);
}

export function writeFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const { data, body } = parseMarkdown(raw);
  const merged: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  if (Object.keys(merged).length === 0) return body;
  return matter.stringify(body, merged);
}

/** A page's `component:` block (#236), as written — not yet resolved to a connector. */
export interface ComponentFrontmatter {
  /** `owner/repo` or a repository URL; null when the page names none. */
  repository: string | null;
  /** Repo-relative files, directories or globs, leading `./` and `/` removed. */
  paths: string[];
  symbols: string[];
  /** `component.name`, when the block gives one. */
  name: string | null;
}

/** One string or a list of them; anything else is nothing. */
function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return items.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean);
}

/**
 * The `component:` block, or null when the page has none.
 *
 * Lenient about shape, like the relation reader: a single `paths: x.ts` string
 * is a list of one, and blank entries (a template placeholder left empty) are
 * dropped. A block that keeps no path is still returned, with `paths` empty,
 * so the page can say its declaration is unusable rather than look undeclared.
 */
export function readComponentFrontmatter(data: Record<string, unknown> | null | undefined): ComponentFrontmatter | null {
  const entry = Object.entries(data ?? {}).find(([key]) => key.trim().toLowerCase() === 'component');
  if (!entry || entry[1] === null || entry[1] === undefined) return null;
  const block = typeof entry[1] === 'object' && !Array.isArray(entry[1]) ? (entry[1] as Record<string, unknown>) : {};
  const repository = typeof block.repository === 'string' && block.repository.trim() ? block.repository.trim() : null;
  const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : null;
  const paths = [...new Set(stringList(block.paths).map((p) => p.replace(/^(\.\/)+|^\/+/, '')).filter(Boolean))];
  return { repository, paths, symbols: [...new Set(stringList(block.symbols))], name };
}

/**
 * `data` with fixes applied to its `component.paths` (#236): each entry the
 * change removed is dropped, each it moved is rewritten, and every other byte
 * of the block is kept as written. Null when nothing would change — the block
 * is gone, or someone already made the edit — or when no path would be left,
 * which is not a fix but a component that no longer exists.
 */
export function withComponentPaths(
  data: Record<string, unknown>,
  fixes: ReadonlyArray<{ from: string; to: string | null }>,
): Record<string, unknown> | null {
  const entry = Object.entries(data).find(([key]) => key.trim().toLowerCase() === 'component');
  if (!entry || !entry[1] || typeof entry[1] !== 'object' || Array.isArray(entry[1])) return null;
  const [key, value] = entry;
  const block = value as Record<string, unknown>;
  const byFrom = new Map(fixes.map((f) => [f.from, f.to]));
  const written = Array.isArray(block.paths) ? block.paths : block.paths === undefined ? [] : [block.paths];

  let changed = false;
  const paths: unknown[] = [];
  for (const raw of written) {
    const normalized = typeof raw === 'string' ? raw.trim().replace(/^(\.\/)+|^\/+/, '') : null;
    if (normalized === null || !byFrom.has(normalized)) {
      paths.push(raw);
      continue;
    }
    changed = true;
    const to = byFrom.get(normalized);
    if (to && !paths.includes(to)) paths.push(to);
  }
  if (!changed || !paths.some((p) => typeof p === 'string' && p.trim())) return null;
  return { ...data, [key]: { ...block, paths } };
}
