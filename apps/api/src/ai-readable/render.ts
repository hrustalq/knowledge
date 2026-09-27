import { createHash } from 'node:crypto';
import { composeFrontmatter } from '../common/frontmatter.js';

/**
 * Pure renderers for AI-readable output (issue #68): the plain-markdown page,
 * its ETag, and the Accept negotiation that decides whether a route answers in
 * markdown. No Nest, no I/O — the golden strings live in `test/ai-readable.spec.ts`.
 */

/** Bumped when the rendered shape changes, so every cached ETag goes stale. */
export const AI_READABLE_FORMAT_VERSION = 1;

/** Synthesized keys go under this one key, so they can never collide with a page's own `title:`/`url:`. */
export const KNOWLEDGE_FRONTMATTER_KEY = 'knowledge';

export interface PageMeta {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  /** Project name. */
  project: string;
  /** Human URL of the page on the web origin. */
  url: string;
  /** When the served revision was finalized (ISO). */
  updatedAt: string;
}

export interface PageContent {
  title: string;
  /** The body with the frontmatter block split off (what `getContent` returns). */
  body: string;
  frontmatter: Record<string, unknown> | null;
}

const LEADING_H1 = /^#[ \t]+\S/;

/**
 * `# {title}\n\n{body}`, or — with `frontmatter` — the page's own YAML block
 * with our provenance under `knowledge:` and a `title:` if the page has none.
 *
 * Authored keys always win: a connector-written `url:` or a hand-set `title:`
 * is the page's data, and an export that rewrote it would round-trip wrong. Ours
 * are namespaced instead (open question 6 on #68, decided for the namespace).
 *
 * A body that already opens with an H1 keeps it rather than getting a second.
 */
export function renderPageMarkdown(page: PageContent, meta: PageMeta, opts: { frontmatter: boolean }): string {
  const body = page.body.replace(/^\s*\n/, '');
  const text = LEADING_H1.test(body) ? body : `# ${page.title}\n\n${body}`;
  if (!opts.frontmatter) return text;

  const own = page.frontmatter ?? {};
  const data: Record<string, unknown> = {
    ...(own.title === undefined ? { title: page.title } : {}),
    ...own,
    [KNOWLEDGE_FRONTMATTER_KEY]: {
      document_id: meta.documentId,
      revision_id: meta.revisionId,
      revision_number: meta.revisionNumber,
      project: meta.project,
      url: meta.url,
      updated_at: meta.updatedAt,
    },
  };
  return composeFrontmatter(text, data);
}

/**
 * Strong validator over everything the representation depends on. Content is
 * immutable per revision id, so the id stands in for the bytes: a 304 costs one
 * PG read and no S3 fetch.
 */
export function etagFor(input: { revisionId: string; title: string; project: string; frontmatter: boolean }): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([AI_READABLE_FORMAT_VERSION, input.revisionId, input.title, input.project, input.frontmatter]),
    )
    .digest('hex');
  return `"${hash.slice(0, 32)}"`;
}

/** RFC 9110 §13.1.2: a list, weak comparison, `*` matches any current representation. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = etag.replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .map((v) => v.trim())
    .some((v) => v === '*' || v.replace(/^W\//, '') === bare);
}

function qualities(accept: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of accept.split(',')) {
    const [type, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (!type) continue;
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9.]+)$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    out.set(type, Math.max(out.get(type) ?? 0, q));
  }
  return out;
}

/**
 * Whether a route that speaks JSON by default should answer in markdown.
 *
 * Only an explicit `text/markdown` that strictly outranks JSON flips it —
 * wildcards (`*∕*`, `text/*`) never do, and a tie keeps JSON, so no existing
 * client (the web sends `application/json, text/plain, *∕*`) changes shape.
 */
export function prefersMarkdown(accept: string | undefined): boolean {
  if (!accept) return false;
  const q = qualities(accept);
  const md = q.get('text/markdown') ?? 0;
  if (md <= 0) return false;
  const json = Math.max(q.get('application/json') ?? 0, q.get('application/*') ?? 0, q.get('*/*') ?? 0);
  return md > json;
}

export function wantsFrontmatter(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}
