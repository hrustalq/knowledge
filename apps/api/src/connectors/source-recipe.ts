import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import {
  SOURCE_HEADING_TAGS,
  SOURCE_MIN_WORDS_RATIO,
  SOURCE_RECIPE_MAX_RULES,
  SOURCE_RECIPE_MAX_SELECTORS,
  type SourceCheckFailure,
  type SourceRecipe,
  type SourceRecipeRule,
} from '@knowledge/contracts';
import { extractArticle, htmlTitle, htmlToMarkdown } from '../import/parsers/html-to-markdown.js';
import { countWords } from '../import/parsers/parser.types.js';

/**
 * Extraction recipes (#674, phase 2), the pure half: a fetched body plus a
 * recipe in, markdown plus what the checks need out. No database, no network.
 *
 * A recipe is declarative data (selectors, a heading map, landmarks, rules);
 * nothing in it is ever evaluated as code. A null recipe is the implicit one:
 * article scoring, checked against the last good version.
 */

/** A fetched body, as the `web` adapter read it. */
export interface SourceBody {
  body: string;
  contentType: string;
  url: string;
}

/** The last good version, which the checks compare against. */
export interface SourceBaseline {
  words: number;
  /** Its h1/h2 heading texts, folded. */
  headings: string[];
}

/** The source's structure: what a layout change moves and a content edit does not. */
export interface SourceFingerprint {
  hash: string;
  /** Landmark elements (`main`, `article`, …) as `tag#id.class`, digit-bearing classes dropped. */
  frame: string[];
  /** The heading levels the content uses, e.g. "123". */
  levels: string;
}

export interface SourceExtraction {
  markdown: string;
  title?: string;
  words: number;
  headings: string[];
  /** Selector → elements matched, for every selector and landmark the recipe names. */
  hits: Record<string, number>;
  /** Null for a markdown source: it converts deterministically and has no layout. */
  fingerprint: SourceFingerprint | null;
  /** False when the content selectors matched nothing, or scoring found no words. */
  contentFound: boolean;
}

export function isMarkdownBody(contentType: string, url: string): boolean {
  if (contentType === 'text/markdown' || contentType === 'text/x-markdown') return true;
  // Raw file hosts serve `.md` as text/plain (GitHub raw) or with no type.
  const path = new URL(url).pathname.toLowerCase();
  return (contentType === 'text/plain' || contentType === 'application/octet-stream' || contentType === '') && /\.(md|markdown|mdx)$/.test(path);
}

export function isHtmlBody(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

export async function extractSource(source: SourceBody, recipe: SourceRecipe | null): Promise<SourceExtraction> {
  if (isMarkdownBody(source.contentType, source.url)) {
    const markdown = applyRules(source.body, recipe?.rules ?? []);
    return { markdown, words: countWords(markdown), headings: topHeadings(markdown), hits: {}, fingerprint: null, contentFound: true };
  }

  const { document } = new JSDOM(source.body, { url: source.url }).window;
  for (const selector of recipe?.strip ?? []) document.querySelectorAll(selector).forEach((el) => el.remove());
  for (const [tag, level] of Object.entries(recipe?.headings ?? {})) {
    if (level) document.querySelectorAll(tag).forEach((el) => retag(el, `h${level}`));
  }
  const hits: Record<string, number> = {};
  for (const selector of [...(recipe?.content ?? []), ...(recipe?.landmarks ?? [])]) hits[selector] = document.querySelectorAll(selector).length;

  let markdown: string;
  let title = htmlTitle(source.body);
  let contentFound: boolean;
  if (recipe?.content.length) {
    const selector = recipe.content.find((s) => hits[s]! > 0);
    // Outermost matches only: a nested match is already inside its ancestor's HTML.
    const parts = selector ? [...document.querySelectorAll(selector)].filter((el, _i, all) => !all.some((o) => o !== el && o.contains(el))) : [];
    markdown = htmlToMarkdown(parts.map((el) => el.outerHTML).join('\n'));
    contentFound = parts.length > 0;
  } else {
    const article = await extractArticle(document.documentElement.outerHTML, source.url);
    markdown = article.markdown;
    title = article.title ?? title;
    contentFound = article.wordCount > 0;
  }
  markdown = applyRules(markdown, recipe?.rules ?? []);
  return {
    markdown,
    ...(title ? { title } : {}),
    words: countWords(markdown),
    headings: topHeadings(markdown),
    hits,
    fingerprint: fingerprintOf(document, markdown),
    contentFound,
  };
}

/** The checks a version must pass to be published. Empty = it passes. */
export function checkExtraction(ex: SourceExtraction, recipe: SourceRecipe | null, baseline: SourceBaseline | null): SourceCheckFailure[] {
  const failures: SourceCheckFailure[] = [];
  if (!ex.contentFound) failures.push('no-content');
  if ((recipe?.landmarks ?? []).some((s) => !ex.hits[s])) failures.push('landmark');
  if (baseline && baseline.words > 0 && ex.words < baseline.words * SOURCE_MIN_WORDS_RATIO) failures.push('words');
  // With no landmarks (the implicit recipe, or one that only carries rules),
  // headings stand in for them. A rolling check: most sections vanishing at
  // once is a layout change.
  if (!recipe?.landmarks.length && ex.fingerprint && baseline && baseline.headings.length >= 2) {
    const now = new Set(ex.headings);
    const kept = baseline.headings.filter((h) => now.has(h)).length;
    if (kept * 2 < baseline.headings.length) failures.push('headings');
  }
  return failures;
}

export function baselineOf(ex: SourceExtraction): SourceBaseline {
  return { words: ex.words, headings: ex.headings };
}

// ------------------------------------------------------------ normalization

export function applyRules(markdown: string, rules: readonly SourceRecipeRule[]): string {
  let out = markdown;
  for (const rule of rules) {
    if (rule.kind === 'rewrite-links') {
      if (!rule.from) continue;
      out = out.split(`](${rule.from}`).join(`](${rule.to}`).split(`]: ${rule.from}`).join(`]: ${rule.to}`);
      continue;
    }
    const lines = out.split('\n');
    const kept: string[] = [];
    let fenced = false;
    let dropping = 0; // the level of the heading being dropped, 0 = none
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const level = heading[1]!.length;
        if (dropping && level <= dropping) dropping = 0;
        if (rule.kind === 'drop-section' && !dropping && fold(heading[2]!) === fold(rule.heading)) {
          dropping = level;
          continue;
        }
        if (rule.kind === 'rename-heading' && !dropping && fold(heading[2]!) === fold(rule.from)) {
          kept.push(`${heading[1]} ${rule.to.trim()}`);
          continue;
        }
      }
      if (!dropping) kept.push(line);
    }
    out = kept.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  return out.trim();
}

function fold(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function topHeadings(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^#{1,2}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m?.[1]) out.push(fold(m[1]));
  }
  return out;
}

// ------------------------------------------------------------ structure

const FRAME_SELECTOR = 'main, article, [role=main], nav, header, footer, aside';

function fingerprintOf(document: Document, markdown: string): SourceFingerprint {
  const frame = [...document.querySelectorAll(FRAME_SELECTOR)].slice(0, 20).map((el) => {
    // Hashed class names (css-1x2y3) change on every deploy of the site, not with its layout.
    const classes = [...el.classList].filter((c) => !/\d/.test(c)).sort();
    return `${el.tagName.toLowerCase()}${el.id && !/\d/.test(el.id) ? `#${el.id}` : ''}${classes.map((c) => `.${c}`).join('')}`;
  });
  const levels = [...new Set([...markdown.matchAll(/^(#{1,6})\s/gm)].map((m) => m[1]!.length))].sort().join('');
  const hash = createHash('sha256').update(JSON.stringify({ frame, levels })).digest('hex');
  return { hash, frame, levels };
}

function retag(el: Element, tag: string): void {
  if (el.tagName.toLowerCase() === tag) return;
  const next = el.ownerDocument.createElement(tag);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.replaceWith(next);
}

// ------------------------------------------------------------ validation

const probe = new JSDOM('<!doctype html><p></p>').window.document;

function validSelector(selector: string): boolean {
  try {
    probe.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * A recipe from anywhere — a request body or a model's JSON — reduced to its
 * declared shape. `errors` names what was dropped; a person's save refuses on
 * any, the agent's draft keeps the rest.
 */
export function readRecipe(value: unknown): { recipe: SourceRecipe; errors: string[] } {
  const errors: string[] = [];
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const selectors = (key: 'content' | 'strip' | 'landmarks'): string[] => {
    const raw = Array.isArray(v[key]) ? (v[key] as unknown[]) : [];
    const out: string[] = [];
    for (const item of raw) {
      const s = typeof item === 'string' ? item.trim() : '';
      if (!s) continue;
      if (s.length > 300 || !validSelector(s)) errors.push(`${key}: ${String(item).slice(0, 80)}`);
      else if (!out.includes(s)) out.push(s);
    }
    if (out.length > SOURCE_RECIPE_MAX_SELECTORS) errors.push(`${key}: more than ${SOURCE_RECIPE_MAX_SELECTORS}`);
    return out.slice(0, SOURCE_RECIPE_MAX_SELECTORS);
  };
  const headings: SourceRecipe['headings'] = {};
  const rawHeadings = (v.headings && typeof v.headings === 'object' ? v.headings : {}) as Record<string, unknown>;
  for (const tag of SOURCE_HEADING_TAGS) {
    const level = rawHeadings[tag];
    if (level === undefined || level === null) continue;
    if (Number.isInteger(level) && (level as number) >= 1 && (level as number) <= 6) headings[tag] = level as number;
    else errors.push(`headings.${tag}`);
  }
  const rules: SourceRecipeRule[] = [];
  for (const item of Array.isArray(v.rules) ? (v.rules as unknown[]) : []) {
    const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim().slice(0, 500) : '');
    if (r.kind === 'drop-section' && str('heading')) rules.push({ kind: 'drop-section', heading: str('heading') });
    else if (r.kind === 'rename-heading' && str('from') && str('to')) rules.push({ kind: 'rename-heading', from: str('from'), to: str('to') });
    else if (r.kind === 'rewrite-links' && str('from')) rules.push({ kind: 'rewrite-links', from: str('from'), to: str('to') });
    else errors.push(`rules: ${JSON.stringify(item).slice(0, 80)}`);
  }
  if (rules.length > SOURCE_RECIPE_MAX_RULES) errors.push(`rules: more than ${SOURCE_RECIPE_MAX_RULES}`);
  return {
    recipe: { content: selectors('content'), strip: selectors('strip'), headings, landmarks: selectors('landmarks'), rules: rules.slice(0, SOURCE_RECIPE_MAX_RULES) },
    errors,
  };
}

// ------------------------------------------------------------ the agent's view

/** Characters of outline the drafting agent reads. */
const OUTLINE_MAX = 24_000;

/**
 * The page's element tree as the agent drafts from it: `tag#id.class` per
 * line, indented, with the first words of each element's own text. Enough to
 * pick selectors, far smaller than the page. Script, style and SVG are dropped.
 */
export function sourceOutline(html: string, url: string): string {
  const { document } = new JSDOM(html, { url }).window;
  const lines: string[] = [];
  let size = 0;
  const walk = (el: Element, depth: number): void => {
    if (size > OUTLINE_MAX || depth > 14) return;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'svg', 'noscript', 'template', 'link', 'meta'].includes(tag)) return;
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const classes = [...el.classList].slice(0, 4).map((c) => `.${c}`).join('');
    const line = `${'  '.repeat(depth)}${tag}${el.id ? `#${el.id}` : ''}${classes}${own ? ` "${own}"` : ''}`;
    lines.push(line);
    size += line.length + 1;
    for (const child of el.children) walk(child, depth + 1);
  };
  if (document.body) walk(document.body, 0);
  return lines.join('\n').slice(0, OUTLINE_MAX);
}
