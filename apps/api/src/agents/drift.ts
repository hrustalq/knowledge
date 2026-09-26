import type { AgentFinding, AgentRunPullRequest } from '@knowledge/contracts';
import { isManifestPath, OVERVIEW_KEY } from '../connectors/adapters/repo-map.js';
import type { PullRequestFile } from '../connectors/adapters/pull-request.js';
import { isCovered, MIN_DRAFT_CHARS } from './archaeology.js';

/**
 * The deterministic half of the sentinel (docs/features/35).
 *
 * Which files a change touches, which pages those files are tied to and why,
 * and which part of the diff each page needs to be shown, are all questions a
 * program answers — so they are answered here, with no model and no Nest, and
 * the executor spends the model only on the judgement: whether a page says
 * something the change makes untrue. The archaeologist's shape, pointed at a
 * diff instead of a snapshot.
 */

/** Pages judged in one run — one model call each, so this is the cost. */
export const MAX_DRIFT_PAGES = 8;
/** Characters of diff one judgement is shown. */
export const MAX_DIFF_CHARS = 24_000;
/** Characters of the page one judgement is shown. */
export const MAX_PAGE_CHARS = 30_000;
/** Search hits taken as candidates; they are the weakest tie, so the fewest. */
export const MAX_SEARCHED_PAGES = 3;

/** Why a page is thought to be about a change. Strongest first. */
export type DriftTie = 'linked' | 'mentioned' | 'searched';

export interface DriftCandidate {
  documentId: string;
  title: string;
  tie: DriftTie;
  /** Human-readable, for the prompt: "module apps/api", "mentions src/pricing.ts". */
  reasons: string[];
  /** The changed files that tie this page to the change — what its diff excerpt shows. */
  files: string[];
}

/** The connector's `subdir`, read off its config the way `repoSubdir` reads it off a context. */
export function subdirOf(config: unknown): string {
  const value = (config as Record<string, unknown> | null)?.subdir;
  return typeof value === 'string' ? value.replace(/^\/+|\/+$/g, '') : '';
}

/** Only the part of the change the connector reads. */
export function scopeFiles(files: PullRequestFile[], subdir: string): PullRequestFile[] {
  if (!subdir) return files;
  const under = (path: string | null) => !!path && (path === subdir || path.startsWith(`${subdir}/`));
  return files.filter((f) => under(f.path) || under(f.previousPath));
}

/**
 * Pages the connector itself wrote about the changed code, from its links.
 *
 * For `codebase` a link's `externalId` is a module (`module:<dir>`) or the hub
 * (`overview`), so a changed file ties to the **deepest** module containing it
 * — the repo map's own deepest-root-wins rule, or a monorepo's root module
 * would claim every change — and a change to the repository's *shape* (a
 * manifest, a file added, removed or moved) ties to the hub.
 *
 * For `markdown-git` a link's `externalId` is a markdown path, and a changed
 * one is the change **documenting itself**: that page will be updated by the
 * next sync once the change merges, so it is returned as `inChange` and never
 * judged — telling a reviewer that the doc they are editing is out of date is
 * noise.
 */
export function linkedCandidates(
  kind: string,
  links: Array<{ externalId: string; documentId: string }>,
  files: PullRequestFile[],
): { ties: Map<string, { reasons: string[]; files: string[] }>; inChange: Set<string> } {
  const ties = new Map<string, { reasons: string[]; files: string[] }>();
  const inChange = new Set<string>();
  const tie = (documentId: string, reason: string, file: string) => {
    const entry = ties.get(documentId) ?? { reasons: [], files: [] };
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    if (!entry.files.includes(file)) entry.files.push(file);
    ties.set(documentId, entry);
  };

  if (kind === 'markdown-git') {
    const byPath = new Map(links.map((l) => [l.externalId, l.documentId]));
    for (const f of files) {
      for (const path of [f.path, f.previousPath]) {
        const documentId = path ? byPath.get(path) : undefined;
        if (documentId) inChange.add(documentId);
      }
    }
    return { ties, inChange };
  }

  if (kind !== 'codebase') return { ties, inChange };

  const modules = links
    .filter((l) => l.externalId.startsWith('module:'))
    .map((l) => ({ dir: l.externalId.slice('module:'.length), documentId: l.documentId }))
    // Deepest first, so the first match is the owning module.
    .sort((a, b) => b.dir.length - a.dir.length);
  const overview = links.find((l) => l.externalId === OVERVIEW_KEY)?.documentId;

  for (const f of files) {
    const owner = modules.find((m) => m.dir === '' || f.path === m.dir || f.path.startsWith(`${m.dir}/`));
    if (owner) tie(owner.documentId, `module ${owner.dir || '(repository root)'}`, f.path);
    if (overview && (isManifestPath(f.path) || f.status !== 'modified')) {
      tie(overview, 'the repository hub (a manifest or the file layout changed)', f.path);
    }
  }
  return { ties, inChange };
}

/**
 * Which changed files a page's text names — by path, by its old path, or by a
 * filename specific enough to mean that file. The archaeologist's coverage
 * test, pointed the other way: there it asks whether anything declares a file,
 * here whether this page declares something about one that just changed.
 */
export function mentionedFiles(pageText: string, files: PullRequestFile[]): string[] {
  const lower = pageText.toLowerCase();
  const out: string[] = [];
  for (const f of files) {
    if (isCovered(lower, f.path, []) || (f.previousPath && isCovered(lower, f.previousPath, []))) out.push(f.path);
  }
  return out;
}

/**
 * The part of the diff one page is judged against, cut at a file boundary.
 * Files the host withheld a patch for are still listed, so the model knows the
 * file changed even when it cannot see how.
 */
export function diffExcerpt(files: PullRequestFile[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const f of files) {
    const moved = f.previousPath ? ` (was ${f.previousPath})` : '';
    const head = `--- ${f.path} [${f.status}]${moved}`;
    const block = f.patch ? `${head}\n${f.patch}` : `${head}\n(no diff available — binary or too large)`;
    if (used + block.length > maxChars) {
      if (parts.length === 0) parts.push(`${block.slice(0, maxChars)}\n[truncated]`);
      else omitted += 1;
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  if (omitted > 0) parts.push(`[${omitted} more changed file(s) not shown]`);
  return parts.join('\n\n');
}

/** A short search query for pages about this change: its title and the names of what it touches. */
export function searchQueryFor(pr: AgentRunPullRequest, files: PullRequestFile[]): string {
  const names = files
    .slice(0, 8)
    .map((f) => (f.path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''))
    .filter((n) => n.length >= 4);
  return [pr.title, ...new Set(names)].join(' ').slice(0, 300);
}

// ---- the model's contract ----------------------------------------------------

export const DRIFT_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape {"drifted": boolean, "severity": "info"|"warning"|"error", ' +
  '"title": string, "detail": string, "markdown": string|null}. ' +
  '"drifted" is true only when the change makes a specific statement on the page wrong, or leaves out ' +
  'something the page promises to cover — a renamed option, a changed default, a removed step, a new rule. ' +
  'A change the page never talks about is not drift, and neither is a page that is merely incomplete in ways ' +
  'the change does not touch. "title" names what drifted in a few words; "detail" quotes or paraphrases the ' +
  'statement and says which file in the change contradicts it, in at most three sentences. ' +
  '"markdown" is the COMPLETE corrected page body without frontmatter: every statement the change does not ' +
  'affect kept exactly as it is, only the drifted ones corrected, and nothing the diff does not support ' +
  'added. Use null when the diff does not tell you enough to write the correction. When "drifted" is false, ' +
  'return empty strings and null.';

/**
 * A judgement is validated, never trusted — `readExcavation`'s rule.
 *
 * The finding cites the page it was about (that is fixed by the executor, not
 * the model, so a judgement cannot point at a different page) and the pull
 * request it was about, with the URL built from the run's input rather than
 * anything the model wrote. A draft that is a sentence, or is the page
 * unchanged, is not a fix and is dropped — the finding stays, as a warning a
 * person resolves by hand.
 */
export function readDriftVerdict(
  value: Record<string, unknown> | null,
  page: { id: string; title: string; markdown: string },
  pr: AgentRunPullRequest,
): AgentFinding | null {
  if (!value || value.drifted !== true) return null;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const detail = typeof value.detail === 'string' ? value.detail.trim() : '';
  if (!title || !detail) return null;

  const severity = value.severity === 'error' || value.severity === 'info' ? value.severity : 'warning';
  const markdown = typeof value.markdown === 'string' ? value.markdown.trim() : '';
  const usable = markdown.length >= MIN_DRAFT_CHARS && markdown !== page.markdown.trim();

  let site = '';
  try {
    site = new URL(pr.url).hostname.replace(/^www\./, '');
  } catch {
    site = '';
  }
  return {
    kind: 'stale',
    severity,
    title: `${page.title} — ${title}`.slice(0, 300),
    detail: detail.slice(0, 2_000),
    documentIds: [page.id],
    documentTitles: [page.title],
    ...(site ? { sources: [{ kind: 'web' as const, url: pr.url, site, title: `#${pr.number} ${pr.title}`.slice(0, 300) }] } : {}),
    ...(usable ? { draft: { title: page.title, markdown } } : {}),
  };
}
