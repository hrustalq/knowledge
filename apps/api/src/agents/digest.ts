import type { AgentFinding } from '@knowledge/contracts';

/**
 * The digest agent's deterministic half (#70, phase 4).
 *
 * What changed is a query the executor runs; everything here is pure — the
 * window, the listing the model is shown, the reading of its answer and the
 * page the run proposes — so the rule that matters is testable without a
 * database: **a digest links only pages the query returned.** The model's
 * prose passes through {@link keepKnownLinks}, and every list in the page is
 * built from the facts, never from the model's answer.
 */

/** The window when there is no earlier digest to start from. */
export const DIGEST_DEFAULT_DAYS = 7;
/** The longest window a digest covers, however long ago the last one ran. */
export const DIGEST_MAX_DAYS = 31;
/** Pages listed per section — a digest is read, not searched. */
export const MAX_DIGEST_PAGES = 30;
/** Merged changes listed. */
export const MAX_DIGEST_MERGES = 20;
/** Highlights kept from the model. */
export const MAX_DIGEST_HIGHLIGHTS = 6;

export interface DigestPage {
  id: string;
  title: string;
  category: string;
}

export interface DigestFacts {
  since: Date;
  until: Date;
  created: Array<DigestPage & { createdAt: Date }>;
  /** Pages whose default branch gained an indexed revision, most revisions first. */
  changed: Array<DigestPage & { revisions: number }>;
  merged: Array<{ title: string; mergedAt: Date; document: DigestPage }>;
  /** Findings other agents reported in the window, by agent name. */
  findings: Array<{ agent: string; count: number }>;
}

/**
 * Where a digest starts: the previous successful digest, so a weekly schedule
 * covers exactly the week and a manual run "what changed since the last one".
 * Bounded by {@link DIGEST_MAX_DAYS}; {@link DIGEST_DEFAULT_DAYS} without one.
 */
export function digestSince(previous: Date | null, now: Date): Date {
  const floor = now.getTime() - DIGEST_MAX_DAYS * 86_400_000;
  if (previous && previous.getTime() < now.getTime()) return new Date(Math.max(previous.getTime(), floor));
  return new Date(now.getTime() - DIGEST_DEFAULT_DAYS * 86_400_000);
}

/** Every page the facts name, id → title: the only pages a digest may cite. */
export function digestKnown(facts: DigestFacts): Map<string, string> {
  const known = new Map<string, string>();
  for (const page of [...facts.created, ...facts.changed, ...facts.merged.map((m) => m.document)]) {
    known.set(page.id, page.title);
  }
  return known;
}

export function isQuietDigest(facts: DigestFacts): boolean {
  return (
    facts.created.length === 0 && facts.changed.length === 0 && facts.merged.length === 0 && facts.findings.length === 0
  );
}

/** `YYYY-MM-DD` in UTC — locale-free, so the worker's host locale never leaks into a page. */
export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The model's view of the period. Ids are given so highlights can cite them. */
export function digestListing(facts: DigestFacts): string {
  const lines = [`Period: ${isoDay(facts.since)} to ${isoDay(facts.until)}.`];
  if (facts.created.length) {
    lines.push('', 'New pages (id | category | title | created):');
    for (const p of facts.created) lines.push(`- ${p.id} | ${p.category} | ${p.title} | ${isoDay(p.createdAt)}`);
  }
  if (facts.changed.length) {
    lines.push('', 'Changed pages (id | category | title | new revisions):');
    for (const p of facts.changed) lines.push(`- ${p.id} | ${p.category} | ${p.title} | ${p.revisions}`);
  }
  if (facts.merged.length) {
    lines.push('', 'Merged changes (page id | page title | change title | merged):');
    for (const m of facts.merged) {
      lines.push(`- ${m.document.id} | ${m.document.title} | ${m.title} | ${isoDay(m.mergedAt)}`);
    }
  }
  if (facts.findings.length) {
    lines.push('', 'Findings other agents reported:');
    for (const f of facts.findings) lines.push(`- ${f.agent}: ${f.count}`);
  }
  return lines.join('\n');
}

export const DIGEST_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape ' +
  '{"summary": string, "highlights": [{"title": string, "detail": string, "documentIds": string[]}]}. ' +
  '"summary" is two to four sentences of plain prose. Every highlight MUST cite at least one page id from ' +
  'the listing, copied exactly; a highlight you cannot tie to a listed page must be left out. Do not write ' +
  `links. At most ${MAX_DIGEST_HIGHLIGHTS} highlights; returning none is a valid answer.`;

export interface DigestHighlight {
  title: string;
  detail: string;
  documentIds: string[];
}

/**
 * The model's highlights, each kept only if it cites a page the facts name —
 * the `readFinding` rule (plan.md §12.7) for a digest.
 */
export function readDigestHighlights(parsed: Record<string, unknown> | null, known: Map<string, string>): DigestHighlight[] {
  const out: DigestHighlight[] = [];
  for (const raw of Array.isArray(parsed?.highlights) ? parsed.highlights : []) {
    if (!raw || typeof raw !== 'object') continue;
    const h = raw as Record<string, unknown>;
    const title = typeof h.title === 'string' ? h.title.trim() : '';
    const detail = typeof h.detail === 'string' ? h.detail.trim() : '';
    const ids = Array.isArray(h.documentIds)
      ? [...new Set(h.documentIds.filter((id): id is string => typeof id === 'string' && known.has(id)))]
      : [];
    if (!title || !detail || ids.length === 0) continue;
    out.push({ title: title.slice(0, 300), detail: keepKnownLinks(detail, known).slice(0, 2_000), documentIds: ids });
    if (out.length >= MAX_DIGEST_HIGHLIGHTS) break;
  }
  return out;
}

const PAGE_LINK = /\[([^\]]*)\]\(\/documents\/([^)\s/]+)\/?\)/g;

/**
 * A page link the model wrote survives only if it points at a page the facts
 * name; any other keeps its text and loses the link. The prompt asks for no
 * links at all — this is the enforcement, not the request.
 */
export function keepKnownLinks(text: string, known: Map<string, string>): string {
  return text.replace(PAGE_LINK, (link, label: string, id: string) => (known.has(id) ? link : label));
}

/** Markdown link text: brackets would end the label early. */
function linkTo(page: { id: string; title: string }): string {
  return `[${page.title.replace(/[[\]]/g, '\\$&')}](/documents/${page.id})`;
}

export interface DigestLabels {
  highlights: string;
  created: string;
  changed: string;
  merged: string;
  findings: string;
  revisions: (n: number) => string;
}

/**
 * The page a digest proposes. Composed here, not by the model: the summary and
 * highlights are the model's words, every list and every link comes from the
 * facts. Published only when a person presses Create page.
 */
export function digestMarkdown(
  facts: DigestFacts,
  summary: string,
  highlights: DigestHighlight[],
  labels: DigestLabels,
): string {
  const known = digestKnown(facts);
  const out: string[] = [keepKnownLinks(summary.trim(), known)];

  if (highlights.length) {
    out.push('', `## ${labels.highlights}`);
    for (const h of highlights) {
      const pages = h.documentIds.map((id) => linkTo({ id, title: known.get(id) ?? id })).join(', ');
      out.push('', `### ${h.title}`, '', keepKnownLinks(h.detail, known), '', pages);
    }
  }
  if (facts.created.length) {
    out.push('', `## ${labels.created}`, '');
    for (const p of facts.created) out.push(`- ${linkTo(p)}`);
  }
  if (facts.changed.length) {
    out.push('', `## ${labels.changed}`, '');
    for (const p of facts.changed) out.push(`- ${linkTo(p)} — ${labels.revisions(p.revisions)}`);
  }
  if (facts.merged.length) {
    out.push('', `## ${labels.merged}`, '');
    for (const m of facts.merged) out.push(`- ${linkTo(m.document)}: ${m.title} (${isoDay(m.mergedAt)})`);
  }
  if (facts.findings.length) {
    out.push('', `## ${labels.findings}`, '');
    for (const f of facts.findings) out.push(`- ${f.agent}: ${f.count}`);
  }
  return out.join('\n') + '\n';
}

/** A highlight as a run finding: `other`, citing the pages it is about. */
export function highlightFinding(h: DigestHighlight, known: Map<string, string>): AgentFinding {
  return {
    kind: 'other',
    severity: 'info',
    title: h.title,
    detail: h.detail,
    documentIds: h.documentIds,
    documentTitles: h.documentIds.map((id) => known.get(id) ?? id),
  };
}
