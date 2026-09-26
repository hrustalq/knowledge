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
