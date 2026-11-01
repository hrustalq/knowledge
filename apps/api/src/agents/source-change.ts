import { operationAnchor, type AgentFinding, type ApiSpecChange } from '@knowledge/contracts';
import { wrapUntrusted } from '../common/untrusted.js';
import { readVerdict, webSources } from './drift.js';

/**
 * The deterministic half of the sentinel's "source changed" check (#674,
 * phase 5b): what a source-backed page's new version changed, section by
 * section, and which linking pages that can concern. Pure, like `drift.ts`;
 * the executor spends the model only on whether a page is now wrong.
 */

/** Characters of changed sections one judgement is shown. */
export const MAX_CHANGE_CHARS = 24_000;

/** One changed section, under the anchor a link would point at, as the judge reads it. */
export interface ChangedSection {
  id: string;
  text: string;
}

/**
 * The heading sections `after` changed: a body that differs, a section added
 * and one removed, each keyed by its anchor id. Text before the first heading
 * has no anchor and is not compared — a link cannot point at it.
 */
export function changedSections(before: Array<{ id: string; body: string }>, after: Array<{ id: string; body: string }>): ChangedSection[] {
  const old = new Map(before.map((s) => [s.id, s.body]));
  const now = new Map(after.map((s) => [s.id, s.body]));
  const out: ChangedSection[] = [];
  for (const [id, body] of now) {
    const was = old.get(id);
    if (was === undefined) out.push({ id, text: `Added:\n${body}` });
    else if (was !== body) out.push({ id, text: `Before:\n${was}\n\nAfter:\n${body}` });
  }
  for (const [id, body] of old) if (!now.has(id)) out.push({ id, text: `Removed:\n${body}` });
  return out;
}

/** A spec version's changes, one section per operation under its anchor (`operationAnchor`). */
export function specChangedSections(changes: ApiSpecChange[]): ChangedSection[] {
  const byOp = new Map<string, string[]>();
  for (const c of changes) {
    const id = operationAnchor(c);
    const what = [c.subject, c.before !== null || c.after !== null ? `${c.before ?? '∅'} → ${c.after ?? '∅'}` : null].filter(Boolean).join(': ');
    const line = `${c.rule} (${c.severity})${what ? ` ${what}` : ''}`;
    byOp.set(id, [...(byOp.get(id) ?? [`${c.method ?? ''} ${c.path}`.trim()]), line]);
  }
  return [...byOp].map(([id, lines]) => ({ id, text: lines.join('\n') }));
}

/** A linking page to judge, and the sections it links (null: the whole page). */
export interface SourceCandidate {
  documentId: string;
  anchors: string[] | null;
}

/**
 * Which linking pages a change can concern. A page linking the whole source
 * is a candidate; one linking only sections is a candidate when one of them
 * changed, and is shown only those. Section linkers come first: theirs is the
 * narrower claim, so they are the likelier to be wrong and the cheaper to judge.
 */
export function judgeCandidates(
  links: Array<{ sourceDocumentId: string; targetAnchor: string | null }>,
  changed: ReadonlySet<string>,
): SourceCandidate[] {
  const pages = new Map<string, { whole: boolean; anchors: Set<string> }>();
  for (const l of links) {
    const page = pages.get(l.sourceDocumentId) ?? { whole: false, anchors: new Set<string>() };
    if (l.targetAnchor === null) page.whole = true;
    else if (changed.has(l.targetAnchor)) page.anchors.add(l.targetAnchor);
    pages.set(l.sourceDocumentId, page);
  }
  const sections: SourceCandidate[] = [];
  const whole: SourceCandidate[] = [];
  for (const [documentId, p] of pages) {
    if (p.whole) whole.push({ documentId, anchors: null });
    else if (p.anchors.size > 0) sections.push({ documentId, anchors: [...p.anchors] });
  }
  return [...sections, ...whole];
}

/** The sections one candidate is shown, cut at a section boundary. */
export function changeExcerpt(sections: ChangedSection[], anchors: string[] | null, maxChars: number): string {
  const shown = anchors ? sections.filter((s) => anchors.includes(s.id)) : sections;
  const parts: string[] = [];
  let used = 0;
  for (const s of shown) {
    const block = `--- #${s.id}\n${s.text}`;
    if (used + block.length > maxChars) {
      if (parts.length === 0) parts.push(`${block.slice(0, maxChars)}\n[truncated]`);
      else {
        parts.push(`[${shown.length - parts.length} more changed section(s) not shown]`);
        break;
      }
      continue;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n\n');
}

export const SOURCE_CHANGE_OUTPUT_CONTRACT =
  'Respond ONLY with a json object of the shape {"drifted": boolean, "severity": "info"|"warning"|"error", ' +
  '"title": string, "detail": string, "quote": string, "markdown": string|null}. ' +
  '"drifted" is true only when the source change makes a specific statement on the page wrong, or removes ' +
  'something the page relies on — a renamed option, a changed default, a removed step or endpoint. A change the ' +
  'page never talks about is not drift. "title" names what drifted in a few words; "detail" quotes or paraphrases ' +
  'the statement and says which changed section contradicts it, in at most three sentences. "quote" is that ' +
  'statement copied character for character from the page (empty when the drift is something left out). ' +
  '"markdown" is the COMPLETE corrected page body without frontmatter: every statement the change does not ' +
  'affect kept exactly as it is, only the drifted ones corrected, and nothing the change does not support added. ' +
  'Use null when the change does not tell you enough to write the correction. When "drifted" is false, return ' +
  'empty strings and null.';

/** The user turn for one page. The source's text is fetched bytes, so it is shown only inside the untrusted wrapper. */
export function sourceChangePrompt(
  source: { title: string; url: string },
  excerpt: string,
  page: { id: string; title: string; markdown: string },
  maxPageChars: number,
): string {
  return (
    `The page below links "${source.title}", a page synced from ${source.url}. A new version of that source ` +
    `changed the sections shown. Decide whether the page below is now wrong.\n\n` +
    wrapUntrusted(excerpt, 'source', 'web') +
    `\n\n<page title=${JSON.stringify(page.title)} documentId="${page.id}">\n${page.markdown.slice(0, maxPageChars)}\n</page>`
  );
}

/**
 * A judgement as a finding — validated, never trusted. The page is the one
 * the executor judged and the source is the connector's URL, never anything
 * the model wrote.
 */
export function readSourceVerdict(
  value: Record<string, unknown> | null,
  page: { id: string; title: string; markdown: string },
  source: { title: string; url: string },
): AgentFinding | null {
  const verdict = readVerdict(value, page);
  if (!verdict) return null;
  return {
    kind: 'stale',
    severity: verdict.severity,
    title: `${page.title} — ${verdict.title}`.slice(0, 300),
    detail: verdict.detail.slice(0, 2_000),
    documentIds: [page.id],
    documentTitles: [page.title],
    ...webSources(source.url, source.title),
    ...(verdict.markdown ? { draft: { title: page.title, markdown: verdict.markdown } } : {}),
  };
}
