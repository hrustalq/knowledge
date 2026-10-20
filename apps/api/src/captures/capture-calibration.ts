import { DEDUPE_TEXT_CHARS, dedupeText } from './capture-dedupe.js';

/**
 * The pure half of the capture threshold calibration (issue #234): labelled
 * probes cut from pages that already exist, and what each
 * candidate threshold would get wrong on them. `backtest.main.ts --captures`
 * does the I/O.
 *
 * Each sampled page yields one section S and its lead paragraph, and four
 * labelled cases scored by raw cosine, best chunk per page — what
 * `CaptureService.similarPages` returns:
 *
 * - **amend** — S under its own heading, against the page with S removed and
 *   every other page in the project. Should amend the page.
 * - **new page** — the same probe with the page removed entirely. Whatever
 *   scores best is another page, so it should start a page of its own.
 * - **restatement** — the page's title and lead paragraph, against the whole
 *   page. Should be dropped as a duplicate.
 * - **same-title new fact** — S under the *page's* title, against the page with
 *   S removed. New knowledge under an old title: should amend, never be dropped.
 *
 * Chunks never cross a heading (`splitMarkdown` → `chunkSections`), so
 * removing S's chunks removes exactly S.
 */

export interface CalibrationChunk {
  documentId: string;
  idx: number;
  text: string;
  headingPath: string[];
}

export interface CalibrationCase {
  documentId: string;
  title: string;
  /** The removed section, as `sectionKey` spells it. */
  section: string;
  sectionTitle: string;
  sectionText: string;
  lead: string;
}

/** Best cosine of a probe against the page it was cut from (`own`) and against any other page (`other`). */
export interface ProbeScore {
  own: number;
  other: number;
  /** The page behind `other`, for `--verbose`. */
  otherDocumentId?: string;
}

export interface CaseScores {
  amend: ProbeScore;
  sameTitle: ProbeScore;
  restatement: ProbeScore;
}

/** A section shorter than this is too thin to stand for a capture. */
export const MIN_SECTION_CHARS = 200;
/** A lead paragraph shorter than this is a byline or a badge, not a statement. */
export const MIN_LEAD_CHARS = 80;
/** A heading under this many pages or more is a template slot, not something one page says. */
export const TEMPLATE_MIN_PAGES = 3;
/** The kind every probe is embedded as — `dedupeText` treats all page kinds alike. */
const PROBE_KIND = 'gotcha';

export const sectionKey = (headingPath: readonly string[]): string => headingPath.join('\u0000');

/** A heading as a template spells it: no emphasis, escapes or numbering, case-folded. */
export function headingSlot(heading: string): string {
  return heading
    .replace(/[*_`\\]/g, '')
    .replace(/^\d+(\.\d+)*\.?\s*/, '')
    .trim()
    .toLocaleLowerCase();
}

/**
 * Section headings that `TEMPLATE_MIN_PAGES` or more pages share ("Foreign
 * keys", "Preconditions", "Change history"). A templated corpus fills such a
 * slot with near-identical text on every page, so it scores closer to its
 * siblings' slot than to its own page — and no capture reads like a template
 * slot. The demo workspace is mostly templated; left in, these sections made
 * another page outrank the section's own on most cases.
 */
export function templatedHeadings(pages: Iterable<readonly CalibrationChunk[]>, minPages = TEMPLATE_MIN_PAGES): Set<string> {
  const pagesBySlot = new Map<string, number>();
  for (const chunks of pages) {
    const slots = new Set(chunks.filter((c) => c.headingPath.length).map((c) => headingSlot(c.headingPath[c.headingPath.length - 1])));
    for (const slot of slots) pagesBySlot.set(slot, (pagesBySlot.get(slot) ?? 0) + 1);
  }
  return new Set([...pagesBySlot].filter(([, n]) => n >= minPages).map(([slot]) => slot));
}

/**
 * A page's case, or null when it has no section that can be removed and still
 * leave a page: one that is a single chunk, sits under a heading that is not a
 * template slot, says at least `MIN_SECTION_CHARS`, and is not the page's only
 * section. The section is picked by a hash of the page id, so a rerun samples
 * the same one.
 */
export function pickCase(
  page: { documentId: string; title: string },
  chunks: readonly CalibrationChunk[],
  templated: ReadonlySet<string> = new Set(),
): CalibrationCase | null {
  const ordered = [...chunks].sort((a, b) => a.idx - b.idx);
  const sections = new Map<string, CalibrationChunk[]>();
  for (const c of ordered) sections.set(sectionKey(c.headingPath), [...(sections.get(sectionKey(c.headingPath)) ?? []), c]);
  if (sections.size < 2) return null;

  const eligible = [...sections.values()]
    .filter((group) => group.length === 1)
    .map((group) => group[0])
    .filter((c) => c.headingPath.length > 0 && c.text.trim().length >= MIN_SECTION_CHARS)
    .filter((c) => !templated.has(headingSlot(c.headingPath[c.headingPath.length - 1])));
  const lead = ordered[0]?.text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .find((p) => p.length >= MIN_LEAD_CHARS);
  if (!eligible.length || !lead) return null;

  const chosen = eligible[fnv(page.documentId) % eligible.length];
  return {
    documentId: page.documentId,
    title: page.title,
    section: sectionKey(chosen.headingPath),
    sectionTitle: chosen.headingPath[chosen.headingPath.length - 1],
    sectionText: chosen.text.trim(),
    lead,
  };
}

/** The three texts a case embeds, as a capture would embed them. */
export function probeTexts(c: CalibrationCase): { amend: string; sameTitle: string; restatement: string } {
  const text = (title: string, main: string) => dedupeText(title, PROBE_KIND, main).slice(0, DEDUPE_TEXT_CHARS);
  return {
    amend: text(c.sectionTitle, c.sectionText),
    sameTitle: text(c.title, c.sectionText),
    restatement: text(c.title, c.lead),
  };
}

/**
 * Best score per page over `chunks`, each already scored against one probe —
 * the same fold as `rankSimilar` — split into the case's own page (minus the
 * section when `withoutSection`) and the best other page.
 */
export function splitScores(
  c: CalibrationCase,
  scored: ReadonlyArray<{ documentId: string; headingPath: string[]; score: number }>,
  withoutSection: boolean,
): ProbeScore {
  let own = 0;
  let other = 0;
  let otherDocumentId: string | undefined;
  for (const s of scored) {
    if (s.documentId === c.documentId) {
      if (withoutSection && sectionKey(s.headingPath) === c.section) continue;
      own = Math.max(own, s.score);
    } else if (s.score > other) {
      other = s.score;
      otherDocumentId = s.documentId;
    }
  }
  return { own, other, ...(otherDocumentId ? { otherDocumentId } : {}) };
}

export interface AmendErrors {
  threshold: number;
  /** amend cases whose best page scores under the threshold: the subject scatters into a new page. */
  scattered: number;
  /** amend cases where another page outranks their own and clears the threshold: a section on the wrong page. */
  wrongPage: number;
  /** new-page cases where some other page clears the threshold: an unrelated page gains a section. */
  falseAmend: number;
}

export interface DedupeErrors {
  threshold: number;
  /** restatements their own page does not top at or above the threshold: a redundant section is proposed. */
  missed: number;
  /** same-title new facts their own page tops at or above it: new knowledge is dropped. */
  dropped: number;
}

/** Shares (0–1) of the cases each amend threshold would get wrong. The amend decision ignores titles. */
export function amendErrors(cases: readonly CaseScores[], threshold: number): AmendErrors {
  const share = (n: number) => (cases.length ? n / cases.length : 0);
  let scattered = 0;
  let wrongPage = 0;
  let falseAmend = 0;
  for (const { amend } of cases) {
    if (Math.max(amend.own, amend.other) < threshold) scattered += 1;
    else if (amend.other > amend.own) wrongPage += 1;
    if (amend.other >= threshold) falseAmend += 1;
  }
  return { threshold, scattered: share(scattered), wrongPage: share(wrongPage), falseAmend: share(falseAmend) };
}

/** Shares (0–1) of the cases each duplicate threshold would get wrong. Both classes carry the page's own title. */
export function dedupeErrors(cases: readonly CaseScores[], threshold: number): DedupeErrors {
  const share = (n: number) => (cases.length ? n / cases.length : 0);
  const tops = (p: ProbeScore) => p.own >= p.other && p.own >= threshold;
  return {
    threshold,
    missed: share(cases.filter((c) => !tops(c.restatement)).length),
    dropped: share(cases.filter((c) => tops(c.sameTitle)).length),
  };
}

/** 0.50, 0.52 … 0.98 — integers first, so no step accumulates float error. */
export function thresholdGrid(from = 50, to = 98, step = 2): number[] {
  const grid: number[] = [];
  for (let i = from; i <= to; i += step) grid.push(i / 100);
  return grid;
}

/** FNV-1a: a stable pick per id, so a re-run samples the same cases. */
export function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
