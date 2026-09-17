import type { AgentFinding, AssistantWebSource } from '@knowledge/contracts';
import { languageForPath } from '../connectors/adapters/tree-sitter.service.js';
import type { RepoSnapshot } from '../connectors/code-research/repo-snapshot.service.js';

/**
 * The deterministic half of the archaeologist (docs/features/31).
 *
 * Which files a repository has, which of them say something about the project
 * (the documents), which of the rest decide something (the candidates), and
 * which of those nothing mentions (the uncovered) are all questions with
 * answers a program can compute. They are computed here, with no model and no
 * Nest, so the executor spends the model only on the judgement — what a file
 * decides, said for a reader who has not opened it — and so the ranking can be
 * tested against a fake archive.
 */

/** Source files the archaeologist reads in one run — one tool loop each, so this is the cost. */
export const MAX_CANDIDATE_FILES = 12;
/** Files ranked before coverage is checked; outlining them costs a parse each. */
export const MAX_RANKED_FILES = 60;
/** Findings kept from one file; a file that yields more is a file that needs splitting, not more pages. */
export const MAX_FINDINGS_PER_FILE = 3;
/** Characters of declared text handed to the digest call. */
export const MAX_DIGEST_INPUT_CHARS = 60_000;
/** Characters of the file shown in the prompt — the model reads the rest through the tools. */
export const MAX_PREVIEW_CHARS = 12_000;
/** A draft shorter than this is a sentence, not a page. */
export const MIN_DRAFT_CHARS = 200;
/** Source citations kept on one finding. */
export const MAX_SOURCES_PER_FINDING = 8;

/** A file that is about the project rather than part of it. */
export interface RepoDoc {
  path: string;
  text: string;
}

/** A source file worth reading, in the order it is worth reading. */
export interface Candidate {
  path: string;
  bytes: number;
  lines: number;
  score: number;
}

// ---- documents --------------------------------------------------------------

const DOC_EXTENSION = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const DOC_NOISE = /(^|\/)(CHANGELOG|LICENSE|LICENCE|NOTICE|CODE_OF_CONDUCT|SECURITY)[^/]*$/i;
const DOC_DIRS = /(^|\/)(docs?|documentation|adr|adrs|rfcs?|design|wiki|guides?)\//i;
const DOC_NAMES = /(^|\/)(README|CONTRIBUTING|ARCHITECTURE|DESIGN|OVERVIEW|HACKING|DEVELOPING)[^/]*$/i;

/**
 * The repository's own account of itself, README first.
 *
 * Ordered by how much a document is likely to say about the whole: the root
 * README, then anything under a docs directory or with a documenting name,
 * then every other document by path. The order matters because the digest is
 * capped — when it bites, it should bite the file least likely to be an
 * overview.
 */
export function selectRepoDocs(files: Map<string, Uint8Array>): RepoDoc[] {
  const rank = (path: string): number => {
    const depth = path.split('/').length;
    if (/^README[^/]*$/i.test(path)) return 0;
    if (DOC_NAMES.test(path)) return 1 + depth;
    if (DOC_DIRS.test(path)) return 10 + depth;
    return 100 + depth;
  };
  const docs: Array<{ path: string; bytes: Uint8Array; rank: number }> = [];
  for (const [path, bytes] of files) {
    if (!DOC_EXTENSION.test(path) || DOC_NOISE.test(path)) continue;
    docs.push({ path, bytes, rank: rank(path) });
  }
  docs.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  return docs.map((d) => ({ path: d.path, text: Buffer.from(d.bytes).toString('utf8') }));
}

/** Documents concatenated for the model, cut at the cap on a document boundary where possible. */
export function digestInput(docs: RepoDoc[], pages: Array<{ title: string; markdown: string }>, maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  const push = (heading: string, body: string): boolean => {
    const block = `\n\n===== ${heading} =====\n${body.trim()}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used - heading.length - 20;
      if (room > 400) parts.push(block.slice(0, room) + '\n[truncated]');
      return false;
    }
    parts.push(block);
    used += block.length;
    return true;
  };
  for (const page of pages) if (!push(`workspace page: ${page.title}`, page.markdown)) return parts.join('');
  for (const doc of docs) if (!push(`repository document: ${doc.path}`, doc.text)) return parts.join('');
  return parts.join('');
}

/** The headings of every document, for a run that has no model to write the digest. */
export function headingDigest(docs: RepoDoc[], pages: Array<{ title: string; markdown: string }>): string {
  const lines: string[] = [];
  for (const page of pages) lines.push(`- workspace page "${page.title}"`);
  for (const doc of docs) {
    const headings = doc.text
      .split('\n')
      .filter((line) => /^#{1,3}\s/.test(line))
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .slice(0, 12);
    lines.push(`- ${doc.path}${headings.length ? `: ${headings.join(' / ')}` : ''}`);
  }
  return lines.join('\n');
}

// ---- candidates -------------------------------------------------------------

const EXCLUDED_DIR =
  /(^|\/)(tests?|__tests__|__mocks__|specs?|fixtures?|mocks?|e2e|migrations?|dist|build|out|vendor|node_modules|generated|__generated__|\.[^/]+)\//i;
const EXCLUDED_FILE =
  /(\.(spec|test|stories|bench|d|generated|gen|config|conf|setup|mock)\.[^/]+$)|(^|\/)(vite|vitest|jest|eslint|prettier|tailwind|postcss|nest-cli|tsconfig|babel|webpack|rollup|commitlint|lint-staged)[^/]*$/i;
/** Smaller than this is a barrel or a type; larger is generated or a bundle. */
const MIN_CANDIDATE_BYTES = 400;
const MAX_CANDIDATE_BYTES = 200_000;

/**
 * The constructs that mean the code is deciding something, per hundred lines.
 * Branching is the strongest signal; a domain word beside it doubles the
 * evidence that the decision is about the business rather than the plumbing.
 */
const BRANCHING = /\b(if|else if|elif|switch|case|when|match|unless|guard|throw|raise|catch|rescue|except)\b/g;
const DOMAIN =
  /\b(valid(?:ate|ation|ity)?|allow(?:ed|list)?|forbid(?:den)?|denied|permission|role|limit|threshold|quota|budget|price|pricing|discount|tax|fee|status|state|transition|expire[sd]?|expiry|retry|retries|approve[ds]?|approval|reject(?:ed)?|eligib(?:le|ility)|rule|policy|gate|deadline|overdue|refund|invoice|order|payment|balance)\b/gi;

export function isCandidatePath(path: string): boolean {
  if (!languageForPath(path)) return false;
  if (EXCLUDED_DIR.test(path) || EXCLUDED_FILE.test(path)) return false;
  return true;
}

/** How much a file decides, weighted by how much of it there is. */
export function decisionScore(text: string, bytes: number): { score: number; lines: number } {
  const lines = Math.max(1, text.split('\n').length);
  const branching = (text.match(BRANCHING) ?? []).length;
  const domain = (text.match(DOMAIN) ?? []).length;
  const perHundred = ((branching + 0.5 * domain) * 100) / lines;
  return { score: Math.log2(bytes) * (1 + perHundred), lines };
}

/** Every source file that could carry a rule, most decisive first. */
export function rankCandidates(files: Map<string, Uint8Array>, limit: number): Candidate[] {
  const out: Candidate[] = [];
  for (const [path, bytes] of files) {
    if (!isCandidatePath(path)) continue;
    if (bytes.byteLength < MIN_CANDIDATE_BYTES || bytes.byteLength > MAX_CANDIDATE_BYTES) continue;
    const text = Buffer.from(bytes).toString('utf8');
    const { score, lines } = decisionScore(text, bytes.byteLength);
    out.push({ path, bytes: bytes.byteLength, lines, score });
  }
  out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return out.slice(0, limit);
}

// ---- coverage ---------------------------------------------------------------

/** Names too generic to count as a mention of anything in particular. */
const GENERIC_NAMES = new Set([
  'index', 'main', 'app', 'utils', 'util', 'helpers', 'helper', 'types', 'type', 'constants', 'config',
  'service', 'controller', 'module', 'handler', 'handlers', 'lib', 'core', 'common', 'shared', 'base',
  'default', 'export', 'create', 'update', 'delete', 'get', 'set', 'list', 'run', 'init', 'setup',
]);

/**
 * Whether the declared text mentions this file: by path, by its own name, or
 * by two of the names it exports. Two, because a single common word — `merge`,
 * `Order` — appears in prose about anything; two exported names together are
 * a page that is about this file.
 */
export function isCovered(declared: string, path: string, exportedNames: string[]): boolean {
  if (declared.includes(path.toLowerCase())) return true;
  const base = (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase();
  if (base.length >= 6 && !GENERIC_NAMES.has(base) && declared.includes(base)) return true;
  let hits = 0;
  for (const name of exportedNames) {
    const lower = name.toLowerCase();
    if (lower.length < 5 || GENERIC_NAMES.has(lower)) continue;
    if (declared.includes(lower) && ++hits >= 2) return true;
  }
  return false;
}

// ---- the model's contracts --------------------------------------------------

export const DIGEST_CONTRACT =
  'You are given what a repository\'s own documents and the workspace\'s pages already say about it. ' +
  'Respond ONLY with a json object of the shape {"topics": [{"name": string, "summary": string, ' +
  '"paths": string[]}]}: one entry per thing the documents actually explain — a subsystem, a rule, a flow, ' +
  'a decision — with a two-sentence summary and the file paths the documents name for it. At most 40 ' +
  'topics. Record what is declared, never what you infer; this digest is what a later pass uses to decide ' +
  'whether a source file is documented, so an invented topic hides a file that needed a page.';

export const CODE_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape {"findings": [{"title": string, "detail": string, ' +
  '"severity": "info"|"warning", "draft": {"title": string, "markdown": string}, ' +
  '"sources": [{"path": string, "startLine": number, "endLine": number, "note": string}]}]}. ' +
  'One finding per rule or cluster of rules the file decides that the digest does not declare; at most ' +
  `${MAX_FINDINGS_PER_FILE}, and [] when the file decides nothing a reader needs or the digest already ` +
  'covers it. "title" names the rule; "detail" says in two sentences why it matters and that nothing ' +
  'declares it. "draft" is the complete page a person will publish as-is: a title, then markdown with the ' +
  'sections What it decides, The rules (each with its exact condition and outcome), Where it lives, What it ' +
  'depends on, Open questions — written for someone who will not open the file, at least three paragraphs, ' +
  'no code fences longer than ten lines, no preamble. "sources" cite only paths you actually read in this ' +
  'run, with the line range each claim rests on. "severity" is "warning" when the rule can lose money, ' +
  'data or access if misunderstood, "info" otherwise.';

// ---- reading the model's answer ---------------------------------------------

/**
 * One proposed page, validated rather than trusted.
 *
 * The rule `readFinding` applies to page ids, applied to files: a source must
 * name a path that is in the snapshot, or the citation is to nothing. The URL
 * is built here from the path — the model never supplies one, so a finding
 * cannot claim to cite the repository while linking elsewhere. A draft too
 * short to be a page, or a finding with no valid source, is dropped.
 */
export function readExcavation(value: unknown, snapshot: RepoSnapshot, readPaths: ReadonlySet<string>): AgentFinding | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const detail = typeof raw.detail === 'string' ? raw.detail.trim() : '';
  const draft = raw.draft && typeof raw.draft === 'object' ? (raw.draft as Record<string, unknown>) : null;
  const draftTitle = typeof draft?.title === 'string' ? draft.title.trim() : '';
  const draftMarkdown = typeof draft?.markdown === 'string' ? draft.markdown.trim() : '';
  if (!title || !detail || !draftTitle || draftMarkdown.length < MIN_DRAFT_CHARS) return null;

  const sources: AssistantWebSource[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(raw.sources) ? raw.sources : []) {
    if (!entry || typeof entry !== 'object') continue;
    const s = entry as Record<string, unknown>;
    const path = typeof s.path === 'string' ? s.path.trim().replace(/^\.?\//, '') : '';
    // Cited paths must be in the snapshot AND have actually been opened in this
    // run — a path the model saw in a tree listing is not a path it read.
    if (!path || !snapshot.files.has(path) || !readPaths.has(path)) continue;
    const start = typeof s.startLine === 'number' && s.startLine >= 1 ? Math.trunc(s.startLine) : undefined;
    const end = typeof s.endLine === 'number' && start !== undefined && s.endLine >= start ? Math.trunc(s.endLine) : undefined;
    const url = snapshot.blobUrl(path, start !== undefined ? [start, end] : undefined);
    if (seen.has(url)) continue;
    seen.add(url);
    const note = typeof s.note === 'string' ? s.note.trim().slice(0, 500) : '';
    sources.push({
      kind: 'web',
      url,
      site: snapshot.host.origin.replace(/^https?:\/\//, '').replace(/^www\./, ''),
      title: start !== undefined ? `${path}:${start}${end !== undefined && end > start ? `-${end}` : ''}` : path,
      ...(note ? { snippet: note } : {}),
    });
    if (sources.length >= MAX_SOURCES_PER_FINDING) break;
  }
  if (sources.length === 0) return null;

  return {
    kind: 'gap',
    severity: raw.severity === 'warning' ? 'warning' : 'info',
    title: title.slice(0, 300),
    detail: detail.slice(0, 2_000),
    documentIds: [],
    documentTitles: [],
    sources,
    draft: { title: draftTitle.slice(0, 300), markdown: draftMarkdown.slice(0, 40_000) },
  };
}
