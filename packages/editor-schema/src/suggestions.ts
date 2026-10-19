/**
 * Suggestions in a shared draft (#80, #316) without Tiptap or a live DOM:
 * where an assistant's edit lands in a document, and the shape a suggestion is
 * kept in. The Y.Doc side is `@knowledge/editor-schema/suggestion-entries`,
 * apart so that a page with no shared draft never loads Yjs. The editor and
 * the API's MCP draft tools both go through these, so an entry either writes
 * is one the other reads.
 *
 * A suggestion always spans whole top-level blocks of the body. Its range is
 * stored as a pair of Y relative positions on that fragment: the start sticks
 * to the first suggested block and the end to the last, so a block a peer adds
 * just outside the range stays outside it and a discard never takes their text.
 */
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { draftEditNeedsAnchor, type AssistantDraftEdit } from '@knowledge/contracts';
import { markdownToHtml } from '@knowledge/editor-schema/markdown';

/** The draft's pending suggestions, one Y.Map each. */
export const SUGGESTIONS_FIELD = 'suggestions';

/* ------------------------------------------------------------- text */

/**
 * Whitespace as rendered is layout, not content: the same passage yields
 * different runs of spaces depending on where the line broke. Collapsing it is
 * what makes a quote portable between viewports, renderers and clients.
 */
export function normalizeQuote(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export interface Projection {
  /** Visible text, whitespace collapsed to single spaces. */
  text: string;
  /** positions[i] is the document position of text[i]. */
  positions: number[];
}

/**
 * Text as the reader sees it, plus where each character lives in the document.
 *
 * Block boundaries contribute a space even when no whitespace exists in the
 * document, so two paragraphs cannot glue into one match; and whitespace never
 * materializes until a real character follows, which keeps the projection free
 * of leading padding. Both rules mirror the DOM projection exactly.
 */
export function projectDoc(doc: PMNode): Projection {
  let text = '';
  const positions: number[] = [];
  let pendingSpace = false;

  doc.descendants((node, pos) => {
    if (node.isText) {
      const raw = node.text ?? '';
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]!;
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
          pendingSpace = text.length > 0;
          continue;
        }
        if (pendingSpace) {
          text += ' ';
          positions.push(pos + i);
          pendingSpace = false;
        }
        text += ch;
        positions.push(pos + i);
      }
      return false;
    }
    // Entering any block starts a new run of text. Atom blocks (a diagram, a
    // whiteboard) hold no prose the reader can quote, so they only break.
    if (node.isBlock) pendingSpace = text.length > 0;
    return !node.isAtom;
  });

  return { text, positions };
}

/** `markdown` as document content. `document` builds the DOM it is parsed from — the browser's inert one, or jsdom. */
export function markdownToFragment(markdown: string, schema: Schema, document: Document): Fragment {
  if (!markdown.trim()) return Fragment.empty;
  const container = document.createElement('div');
  container.innerHTML = markdownToHtml(markdown);
  return PMDOMParser.fromSchema(schema).parse(container).content;
}

function markdownToText(markdown: string, document: Document): string {
  const container = document.createElement('div');
  container.innerHTML = markdownToHtml(markdown);
  return normalizeQuote(container.textContent ?? '');
}

/* ------------------------------------------------------------- anchors */

/** Start and end of the top-level block holding `pos`. */
function topBlock(doc: PMNode, pos: number): { from: number; to: number } {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  if ($pos.depth === 0) {
    const node = doc.childAfter($pos.pos);
    return { from: node.offset, to: node.offset + (node.node?.nodeSize ?? 0) };
  }
  return { from: $pos.before(1), to: $pos.after(1) };
}

/**
 * The top-level blocks an anchor quote falls in, or null.
 *
 * The model quotes *markdown*; the document holds rendered text. Rendering the
 * quote and searching the same whitespace-folded projection comment anchors
 * use makes `**Owner:** billing` find "Owner: billing". A quote that no longer
 * matches whole — a mention or an embed renders differently — falls back to
 * its opening words and its closing words, which is still enough to name the
 * blocks.
 */
export function resolveAnchorBlocks(
  doc: PMNode,
  anchor: string,
  document: Document,
): { from: number; to: number } | null {
  const quote = markdownToText(anchor, document);
  if (!quote) return null;
  const projection = projectDoc(doc);
  const text = projection.text;
  const find = (needle: string, from = 0) => (needle ? text.indexOf(needle, from) : -1);

  let start = find(quote);
  let end = start >= 0 ? start + quote.length - 1 : -1;
  if (start < 0) {
    const head = quote.slice(0, 40);
    const tail = quote.slice(-40);
    start = find(head);
    if (start < 0) return null;
    const tailAt = find(tail, start);
    end = tailAt >= 0 ? tailAt + tail.length - 1 : start + head.length - 1;
  }
  const from = projection.positions[start];
  const to = projection.positions[end];
  if (from === undefined || to === undefined) return null;
  return { from: topBlock(doc, from).from, to: topBlock(doc, to).to };
}

/**
 * Where an edit goes, before any of it has been written. An anchor that no
 * longer resolves — the caller already checked it against the markdown, so a
 * miss is a rendering difference — lands at the page's end: a visible,
 * discardable place, where dropping it would lose the work.
 */
export function targetRange(
  doc: PMNode,
  edit: Pick<AssistantDraftEdit, 'op' | 'anchor'>,
  document: Document,
): { from: number; to: number } {
  const end = doc.content.size;
  if (edit.op === 'rewrite') return { from: 0, to: end };
  if (!draftEditNeedsAnchor(edit.op) || !edit.anchor) return { from: end, to: end };
  const blocks = resolveAnchorBlocks(doc, edit.anchor, document);
  if (!blocks) return { from: end, to: end };
  if (edit.op === 'insert_after') return { from: blocks.to, to: blocks.to };
  if (edit.op === 'insert_before') return { from: blocks.from, to: blocks.from };
  return blocks;
}

/** Top-level blocks before `pos`, a position inside a block rounding out to the whole block. */
export function blockIndex(doc: PMNode, pos: number, round: 'down' | 'up'): number {
  let index = 0;
  let at = 0;
  while (index < doc.childCount) {
    const end = at + doc.child(index).nodeSize;
    if (round === 'down' ? end > pos : at >= pos) break;
    at = end;
    index += 1;
  }
  return index;
}

/** Where the block at `index` starts — the end of the document past the last one. */
export function blockStart(doc: PMNode, index: number): number {
  let at = 0;
  for (let i = 0; i < Math.min(index, doc.childCount); i++) at += doc.child(i).nodeSize;
  return at;
}

/* ------------------------------------------------------------- the Y entry */

/** Who a suggestion is credited to. `requestedBy` exists only in a shared draft — alone, it is always you. */
export interface SuggestionCredit {
  agent: AssistantDraftEdit['agent'] | null;
  requestedBy: { userId: string; name: string } | null;
}

/** One suggestion as the shared draft holds it. The credit is the writer's word, like any content in the draft. */
export interface SuggestionEntry extends SuggestionCredit {
  id: string;
  /** Top-level block indices of the body, resolved from the stored relative positions. */
  fromIndex: number;
  toIndex: number;
  /** `Slice.toJSON()` of what it replaced — Discard puts this back. */
  original: unknown;
  originalText: string;
  state: 'streaming' | 'ready';
  /** The Y client that wrote it: while that client is connected, a streaming entry is still being written. */
  clientId: number;
}

/**
 * `doc` with every entry's blocks put back to what they replaced — the page as
 * a publish writes it, for a reader that holds the entries rather than the
 * editor's plugin state. An entry from a build with another schema is left as
 * it reads, as the editor leaves it.
 */
export function withoutSuggestions(doc: PMNode, entries: Pick<SuggestionEntry, 'fromIndex' | 'toIndex' | 'original'>[]): PMNode {
  const tr = new Transform(doc);
  for (const entry of [...entries].sort((a, b) => b.fromIndex - a.fromIndex)) {
    let original: Slice;
    try {
      original = Slice.fromJSON(doc.type.schema, entry.original);
    } catch {
      continue;
    }
    tr.replace(blockStart(tr.doc, entry.fromIndex), blockStart(tr.doc, entry.toIndex), original);
  }
  return tr.doc;
}
