/** A run of snippet text; `hit` runs are a query term as it appears in the chunk. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

const SNIPPET_CHARS = 300;
/** How much text the window keeps before the first match. */
const LEAD_CHARS = 60;
const WORD = /[\p{L}\p{N}]+/gu;

const fold = (s: string) => s.normalize('NFC').toLowerCase();

/**
 * Query words as prefixes (#443): case and NFC folded, words under three
 * letters dropped (they would mark every «и» and «a»), and the last two letters
 * of a long word cut so «сервиса» marks «сервис» and «сервисы» too.
 * ponytail: naive suffix-cut stemmer, swap for Snowball if highlights miss inflections the BM25 leg matched.
 */
export function queryStems(query: string): string[] {
  const stems = (fold(query).match(WORD) ?? [])
    .filter((w) => w.length >= 3)
    .map((w) => (w.length > 4 ? w.slice(0, Math.max(4, w.length - 2)) : w));
  return [...new Set(stems)];
}

/**
 * A window of `text` around the first word a query stem starts, every such
 * word in it a `hit` run. No match — a hit the vector leg found on meaning
 * alone — is the chunk's opening, with no marks: a highlight is never invented.
 */
export function snippetPartsOf(text: string, query: string): SnippetPart[] {
  const stems = queryStems(query);
  const matches = [...text.matchAll(WORD)]
    .filter((m) => stems.some((s) => fold(m[0]).startsWith(s)))
    .map((m) => ({ start: m.index, end: m.index + m[0].length }));

  let start = 0;
  if (matches.length && matches[0].start > LEAD_CHARS) {
    // Start the window on a word boundary, never mid-word.
    const space = text.lastIndexOf(' ', matches[0].start - LEAD_CHARS);
    start = space === -1 ? 0 : space + 1;
  }
  const end = Math.min(text.length, start + SNIPPET_CHARS);

  const parts: SnippetPart[] = [];
  const push = (t: string, hit: boolean) => {
    if (!t) return;
    const last = parts.at(-1);
    if (last && last.hit === hit) last.text += t;
    else parts.push({ text: t, hit });
  };
  if (start > 0) push('…', false);
  let at = start;
  for (const m of matches) {
    if (m.start < start || m.end > end) continue;
    push(text.slice(at, m.start), false);
    push(text.slice(m.start, m.end), true);
    at = m.end;
  }
  push(text.slice(at, end), false);
  if (end < text.length) push('…', false);
  return parts;
}
