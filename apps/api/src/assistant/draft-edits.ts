/**
 * `edit_draft` on the server's side (docs/features/34): deciding whether an
 * edit can land, and keeping the turn's copy of the draft in step with it.
 *
 * The server never stores a draft. What it holds is the markdown the editor
 * sent with this turn, updated as the turn's own edits are applied, so that a
 * second edit in the same turn is checked against the page the first one left
 * behind rather than the page as it was sent.
 *
 * Block-level, like the editor: an anchor finds the block(s) it falls in, and
 * the edit replaces or sits beside those whole blocks. A block here is what a
 * blank line delimits — the markdown shape of a paragraph, heading, list or
 * table — which is the same unit the editor resolves the quote to.
 */
import { draftEditNeedsAnchor, type DraftEditOp } from '@knowledge/contracts';

export type AnchorResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: 'missing' | 'ambiguous'; count: number };

/** Every index at which `needle` starts in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/**
 * Where a quote sits in the draft. Exact first; failing that, with runs of
 * whitespace treated as one — a model re-flowing a line break into a space is
 * still quoting the same words. A quote found more than once is refused rather
 * than guessed: the model can always quote more.
 */
export function locateAnchor(markdown: string, anchor: string): AnchorResult {
  const quote = anchor.trim();
  if (!quote) return { ok: false, reason: 'missing', count: 0 };
  const exact = occurrences(markdown, quote);
  if (exact.length === 1) return { ok: true, start: exact[0]!, end: exact[0]! + quote.length };
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', count: exact.length };

  // Collapse whitespace in the draft while remembering where each kept
  // character came from, so a match maps back to real offsets.
  let folded = '';
  const origin: number[] = [];
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i]!;
    if (/\s/.test(ch)) {
      if (folded.endsWith(' ')) continue;
      folded += ' ';
    } else {
      folded += ch;
    }
    origin.push(i);
  }
  const want = quote.replace(/\s+/g, ' ');
  const loose = occurrences(folded, want);
  if (loose.length !== 1) return { ok: false, reason: loose.length ? 'ambiguous' : 'missing', count: loose.length };
  const start = origin[loose[0]!]!;
  const end = origin[loose[0]! + want.length - 1]! + 1;
  return { ok: true, start, end };
}

/** Widens a span to the whole blank-line-delimited blocks it touches. */
function blockSpan(markdown: string, start: number, end: number): { start: number; end: number } {
  const before = markdown.lastIndexOf('\n\n', start);
  const after = markdown.indexOf('\n\n', end);
  return { start: before < 0 ? 0 : before + 2, end: after < 0 ? markdown.length : after };
}

/** The draft with one edit applied. Assumes the anchor was already located. */
export function applyDraftEdit(
  markdown: string,
  edit: { op: DraftEditOp; anchor: string | null; markdown: string },
): string {
  const text = edit.markdown.trim();
  if (edit.op === 'rewrite') return text;
  if (edit.op === 'append') return markdown.trimEnd() ? `${markdown.trimEnd()}\n\n${text}\n` : `${text}\n`;
  const found = locateAnchor(markdown, edit.anchor ?? '');
  if (!found.ok) return markdown;
  const span = blockSpan(markdown, found.start, found.end);
  const head = markdown.slice(0, span.start);
  const block = markdown.slice(span.start, span.end);
  const tail = markdown.slice(span.end);
  switch (edit.op) {
    case 'replace':
      // An empty replacement deletes the block, and takes its separator with it.
      return text ? head + text + tail : (head.replace(/\n\n$/, '') + tail).replace(/^\n\n/, '');
    case 'insert_after':
      return `${head}${block}\n\n${text}${tail}`;
    case 'insert_before':
      return `${head}${text}\n\n${block}${tail}`;
  }
}

/** Why an edit cannot land, in words the model can act on — or null when it can. */
export function refuseDraftEdit(
  markdown: string,
  edit: { op: string; anchor: string | null; markdown: string },
  ops: readonly string[],
): string | null {
  if (!ops.includes(edit.op)) return `op must be one of: ${ops.join(', ')}`;
  const op = edit.op as DraftEditOp;
  if (!edit.markdown.trim() && op !== 'replace') return 'markdown is empty — nothing to add';
  if (!draftEditNeedsAnchor(op)) return null;
  if (!edit.anchor?.trim()) return `${op} needs an anchor quoted from the draft`;
  const found = locateAnchor(markdown, edit.anchor);
  if (found.ok) return null;
  return found.reason === 'missing'
    ? 'anchor was not found in the draft — copy it exactly from the current draft text'
    : `anchor appears ${found.count} times in the draft — quote more of the surrounding text so it is unique`;
}
