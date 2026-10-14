import {
  parseConventionalCommit,
  type BreakingChangeSource,
  type ReleaseNoteGroup,
} from '@knowledge/contracts';
import type { CodeSymbol } from './code-symbols.js';
import type { RepoCommit } from './repo-history.js';

/**
 * Release notes, from history to a page (docs/features/46). Pure functions:
 * the adapter fetches, this decides and renders.
 *
 * The page mirrors our own CHANGELOG.md — Breaking, Added, Changed, Fixed,
 * Removed — plus Other for everything that does not say what it is. Three of
 * the four ways a change is found to be breaking are facts this file can show
 * a reader (a conventional `!` or footer, a label on the merged request, an
 * export that went away or changed shape); the fourth, a model's suspicion, is
 * rendered apart and never joins them.
 */

export interface ReleaseEntry {
  group: ReleaseNoteGroup;
  /** One line, from the commit or request subject. Repository text: escaped on render. */
  text: string;
  scope: string | null;
  /** How a breaking entry was found to be breaking. */
  sources: BreakingChangeSource[];
  /** A `BREAKING CHANGE:` footer — what a consumer must do. */
  note: string | null;
  /** `#12` or a short sha — the label a model may cite back, and the link text. */
  ref: string;
  url: string;
}

export interface ClassifyOptions {
  conventional: boolean;
  /** Merged request number → the breaking labels it carries. */
  labelled: Map<number, string[]>;
  requestNumberOf(message: string): number | null;
  requestUrl(n: number): string;
  commitUrl(sha: string): string;
}

const GROUP_BY_TYPE: Record<string, ReleaseNoteGroup> = {
  feat: 'added',
  feature: 'added',
  fix: 'fixed',
  bugfix: 'fixed',
  perf: 'changed',
  refactor: 'changed',
  revert: 'changed',
  remove: 'removed',
  removed: 'removed',
  deprecate: 'removed',
};

/**
 * Commits → entries, one per merged request (a merge-commit repository lands
 * several commits per request) or per commit when there is no request.
 * Merge commits read their subject from the line the host put under the
 * "Merge pull request" header, which is the request's title.
 */
export function classifyCommits(commits: RepoCommit[], opts: ClassifyOptions): ReleaseEntry[] {
  const byKey = new Map<string, ReleaseEntry>();
  for (const commit of commits) {
    const lines = commit.message.split('\n');
    const first = lines[0]?.trim() ?? '';
    if (/^Merge (branch|remote-tracking branch) /.test(first)) continue;
    const number = opts.requestNumberOf(commit.message);
    const isMergeCommit = /^Merge pull request #\d+/.test(first);
    const subjectLine = isMergeCommit ? (lines.slice(1).find((l) => l.trim())?.trim() ?? first) : first;
    const message = isMergeCommit ? lines.slice(1).join('\n').trim() || first : commit.message;

    const parsed = opts.conventional ? parseConventionalCommit(message) : null;
    const sources: BreakingChangeSource[] = [];
    if (parsed?.breaking) sources.push('conventional-commit');
    if (number !== null && opts.labelled.has(number)) sources.push('label');

    const entry: ReleaseEntry = {
      group: sources.length > 0 ? 'breaking' : parsed ? (GROUP_BY_TYPE[parsed.type] ?? 'other') : 'other',
      // The request number is the link; it is not part of what changed.
      text: (parsed?.description ?? subjectLine).replace(/\s*\(#\d+\)\s*$/, '').slice(0, 200),
      scope: parsed?.scope ?? null,
      sources,
      note: parsed?.breakingNote?.slice(0, 500) ?? null,
      ref: number !== null ? `#${number}` : commit.sha.slice(0, 7),
      url: number !== null ? opts.requestUrl(number) : opts.commitUrl(commit.sha),
    };

    const key = number !== null ? `pr:${number}` : `sha:${commit.sha}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    // Several commits for one request: the request is breaking if any of them
    // says so, and the most specific group wins over Other.
    existing.sources = [...new Set([...existing.sources, ...entry.sources])];
    existing.note ??= entry.note;
    if (existing.sources.length > 0) existing.group = 'breaking';
    else if (existing.group === 'other' && entry.group !== 'other') {
      existing.group = entry.group;
      existing.text = entry.text;
      existing.scope = entry.scope;
    }
  }
  return [...byKey.values()];
}

// --- the exported API, before and after ----------------------------------------

export interface SurfaceChange {
  module: string;
  kind: 'removed' | 'changed' | 'added';
  name: string;
  symbolKind: string;
  before: string | null;
  after: string | null;
}

/**
 * Exported symbols at the base vs the head, per module. A removed export or a
 * changed signature breaks whoever imported it; an added one is a feature.
 * Keyed by kind + name, so a function that became a const is a removal and an
 * addition, which is what it is to a caller.
 */
export function diffApiSurface(
  before: Map<string, CodeSymbol[]>,
  after: Map<string, CodeSymbol[]>,
): SurfaceChange[] {
  const changes: SurfaceChange[] = [];
  const modules = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const module of modules) {
    const was = exportsOf(before.get(module) ?? []);
    const now = exportsOf(after.get(module) ?? []);
    for (const [key, symbol] of was) {
      const next = now.get(key);
      if (!next) changes.push({ module, kind: 'removed', name: symbol.name, symbolKind: symbol.kind, before: symbol.signature, after: null });
      else if (normalizeSignature(next.signature) !== normalizeSignature(symbol.signature)) {
        changes.push({ module, kind: 'changed', name: symbol.name, symbolKind: symbol.kind, before: symbol.signature, after: next.signature });
      }
    }
    for (const [key, symbol] of now) {
      if (!was.has(key)) changes.push({ module, kind: 'added', name: symbol.name, symbolKind: symbol.kind, before: null, after: symbol.signature });
    }
  }
  return changes;
}

function exportsOf(symbols: CodeSymbol[]): Map<string, CodeSymbol> {
  return new Map(symbols.filter((s) => s.exported).map((s) => [`${s.kind} ${s.name}`, s]));
}

function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, ' ').replace(/\s*([(),:<>])\s*/g, '$1').trim();
}

// --- the page -----------------------------------------------------------------

export interface Suspicion {
  ref: string;
  reason: string;
}

export interface ReleasePage {
  summary: string | null;
  entries: ReleaseEntry[];
  surface: SurfaceChange[];
  suspected: Suspicion[];
  /** Why the API surface was not compared, when it was not. */
  surfaceNote: string | null;
  compareUrl: string | null;
  truncated: { total: number; shown: number } | null;
}

const HEADINGS: Record<ReleaseNoteGroup, string> = {
  breaking: 'Breaking',
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  removed: 'Removed',
  other: 'Other',
};

const SOURCE_LABEL: Record<BreakingChangeSource, string> = {
  'conventional-commit': 'conventional commit',
  label: 'label',
  'api-surface': 'API surface',
  model: 'suspected',
};

export function renderReleasePage(page: ReleasePage): string {
  const parts: string[] = [];
  if (page.summary) parts.push(page.summary.trim());

  const removedOrChanged = page.surface.filter((c) => c.kind !== 'added');
  const added = page.surface.filter((c) => c.kind === 'added');

  for (const group of ['breaking', 'added', 'changed', 'fixed', 'removed', 'other'] as const) {
    const lines = page.entries.filter((e) => e.group === group).map(entryLine);
    if (group === 'breaking') lines.push(...removedOrChanged.map(surfaceLine));
    if (group === 'added') lines.push(...added.map(surfaceLine));
    if (lines.length > 0) parts.push([`## ${HEADINGS[group]}`, '', ...lines].join('\n'));
  }

  if (page.suspected.length > 0) {
    parts.push(
      [
        '## Possibly breaking',
        '',
        '_Flagged by the model from the change descriptions. Not confirmed by a commit, a label or the code._',
        '',
        ...page.suspected.map((s) => {
          const entry = page.entries.find((e) => e.ref === s.ref);
          return `- ${entry ? `${inline(entry.text)} ([${s.ref}](${entry.url}))` : s.ref} — ${inline(s.reason)}`;
        }),
      ].join('\n'),
    );
  }

  const notes: string[] = [];
  if (page.surfaceNote) notes.push(`_${inline(page.surfaceNote)}_`);
  if (page.truncated) notes.push(`_Showing the newest ${page.truncated.shown} of ${page.truncated.total} commits._`);
  if (page.compareUrl) notes.push(`[Full comparison](${page.compareUrl})`);
  if (notes.length > 0) parts.push(notes.join('\n\n'));

  if (parts.length === 0) return '_No changes._';
  return parts.join('\n\n');
}

export function breakingCount(page: Pick<ReleasePage, 'entries' | 'surface'>): number {
  return page.entries.filter((e) => e.group === 'breaking').length + page.surface.filter((c) => c.kind !== 'added').length;
}

function entryLine(entry: ReleaseEntry): string {
  const scope = entry.scope ? `**${inline(entry.scope)}:** ` : '';
  const how = entry.sources.length > 0 ? ` · ${entry.sources.map((s) => SOURCE_LABEL[s]).join(', ')}` : '';
  const note = entry.note ? `\n  ${inline(entry.note)}` : '';
  return `- ${scope}${inline(entry.text)} ([${entry.ref}](${entry.url}))${how}${note}`;
}

function surfaceLine(change: SurfaceChange): string {
  const where = `\`${change.module}\``;
  if (change.kind === 'removed') return `- Removed ${change.symbolKind} \`${code(change.name)}\` from ${where} · API surface`;
  if (change.kind === 'added') return `- ${change.symbolKind} \`${code(change.name)}\` in ${where}`;
  return `- Changed ${change.symbolKind} \`${code(change.name)}\` in ${where}: \`${code(change.before ?? '')}\` → \`${code(change.after ?? '')}\` · API surface`;
}

/**
 * Repository text placed inline: one line, and nothing that opens markup a
 * commit author could use to restyle the page — HTML, links, images, headings.
 */
function inline(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/, '')
    .trim();
}

function code(text: string): string {
  return text.replace(/`/g, "'").replace(/[\r\n]+/g, ' ');
}
