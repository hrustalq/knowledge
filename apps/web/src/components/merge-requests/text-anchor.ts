/**
 * Quote-based anchoring for review mode (docs/features/13).
 *
 * A diff comment can say "line 42". A comment on the *rendered* page cannot:
 * rendering has no lines, and the reader is looking at prose, tables and
 * panels rather than at source. So a review comment stores the passage it was
 * left on plus a little of the text around it — the W3C TextQuoteSelector
 * shape — and is re-found by searching for it. That survives everything a line
 * number does not: reflow, a paragraph inserted above, a whole section moved.
 *
 * Matching happens against a *projection* of the rendered DOM: its visible
 * text with whitespace collapsed, alongside the exact (text node, offset) each
 * character came from. The collapse is what makes an anchor portable — the
 * same passage yields different runs of spaces depending on where the source
 * line broke — and the point map is what lets a match become a real Range
 * again, so the highlight lands on the actual words.
 */
import type { ReviewThread } from '@knowledge/contracts'
import {
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  contextAround,
  findAnchor,
  normalizeQuote,
  type TextAnchor,
} from '@/lib/anchor-match'

export type { TextAnchor }
export { normalizeQuote }

/** Marks this module owns, so a re-render can strip exactly its own work. */
export const ANNOTATION_ATTR = 'data-kn-thread'

interface Point {
  node: Text
  offset: number
}

interface Projection {
  /** Visible text, whitespace collapsed to single spaces. */
  text: string
  /** points[i] is the source position of text[i]. */
  points: Point[]
}

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE',
  'TABLE', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'ASIDE', 'FIGURE', 'FIGCAPTION',
  'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'HR', 'NAV',
])

function nearestBlock(node: Text): Element | null {
  let el = node.parentElement
  while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement
  return el
}

/**
 * Text the reader sees, plus where each character lives.
 *
 * Two things are deliberate. Block boundaries become a space even when the
 * markup has none, so `</p><p>` cannot glue two words into one match. And
 * whitespace never materializes until a real character follows it, which keeps
 * the projection free of leading and trailing padding — a quote is always
 * trimmed, so it can never start or end on a synthetic space.
 */
function project(root: HTMLElement): Projection {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let text = ''
  const points: Point[] = []
  let pendingSpace = false
  let lastBlock: Element | null = null

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    // The floating comment UI lives inside the canvas, not the page: its text
    // must never enter the projection or every anchor below it would drift.
    if (node.parentElement?.closest('[data-kn-anno-ui]')) continue

    const block = nearestBlock(node)
    if (lastBlock && block !== lastBlock) pendingSpace = text.length > 0
    lastBlock = block

    const raw = node.data
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]!
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
        pendingSpace = text.length > 0
        continue
      }
      if (pendingSpace) {
        text += ' '
        points.push({ node, offset: i })
        pendingSpace = false
      }
      text += ch
      points.push({ node, offset: i })
    }
  }
  return { text, points }
}

function rangeBetween(projection: Projection, start: number, end: number): Range | null {
  const first = projection.points[start]
  const last = projection.points[end - 1]
  if (!first || !last) return null
  const range = first.node.ownerDocument!.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}

/** Projection index of a DOM position, or -1 when it is not inside the text. */
function indexOfPosition(projection: Projection, node: Node, offset: number): number {
  if (node.nodeType !== Node.TEXT_NODE) return -1
  for (let i = 0; i < projection.points.length; i++) {
    const point = projection.points[i]!
    if (point.node === node && point.offset >= offset) return i
  }
  return -1
}

/**
 * Turn the reader's current selection into an anchor.
 *
 * Returns null for anything that cannot be anchored — a collapsed caret, a
 * selection that escaped the page, a passage too short to be findable again or
 * long enough that it is really a comment on the whole document. Callers offer
 * an unanchored thread in those cases rather than guessing a position.
 */
export function anchorFromSelection(root: HTMLElement, revisionId: string): TextAnchor | null {
  const selection = root.ownerDocument.defaultView?.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null

  const quote = normalizeQuote(range.toString())
  if (quote.length < MIN_QUOTE_CHARS || quote.length > MAX_QUOTE_CHARS) return null

  const projection = project(root)
  // Search from the selection's own position: the same words may well appear
  // earlier on the page, and the anchor must describe where the reader is.
  const from = indexOfPosition(projection, range.startContainer, range.startOffset)
  const at = projection.text.indexOf(quote, from >= 0 ? Math.max(0, from - 1) : 0)
  const start = at >= 0 ? at : projection.text.indexOf(quote)
  if (start < 0) return null

  const { prefix, suffix } = contextAround(projection.text, start, quote.length)
  return {
    type: 'text',
    revisionId,
    quote,
    ...(prefix ? { prefix } : {}),
    ...(suffix ? { suffix } : {}),
  }
}

/**
 * Find the passage an anchor points at. Ambiguity is resolved by context, so
 * a term repeated ten times on a page still highlights the occurrence someone
 * actually commented on; when the passage is gone the anchor simply does not
 * resolve and the thread is reported as outdated instead of being re-attached
 * to text nobody reviewed.
 */
export function resolveTextAnchor(root: HTMLElement, anchor: TextAnchor): Range | null {
  const quote = normalizeQuote(anchor.quote)
  if (!quote) return null
  const projection = project(root)
  const best = findAnchor(projection.text, anchor)
  if (best < 0) return null
  return rangeBetween(projection, best, best + quote.length)
}

interface Segment {
  node: Text
  start: number
  end: number
}

function segmentsOf(range: Range): Segment[] {
  const scope = range.commonAncestorContainer
  const host = scope.nodeType === Node.TEXT_NODE ? scope.parentNode! : scope
  const walker = host.ownerDocument!.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  const segments: Segment[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    if (!range.intersectsNode(node)) continue
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    if (end > start) segments.push({ node, start, end })
  }
  return segments
}

/**
 * Wrap a range in `<mark>` elements — one per text node it crosses, because a
 * range that spans elements cannot be surrounded by a single node without
 * rewriting the tree the reader is looking at. Wrapping runs back to front so
 * splitting a later node cannot invalidate an earlier offset.
 */
export function wrapRange(range: Range, decorate: (mark: HTMLElement) => void): HTMLElement[] {
  const marks: HTMLElement[] = []
  for (const segment of segmentsOf(range).reverse()) {
    const { node, start, end } = segment
    if (end < node.length) node.splitText(end)
    const target = start > 0 ? node.splitText(start) : node
    const mark = node.ownerDocument!.createElement('mark')
    decorate(mark)
    target.replaceWith(mark)
    mark.append(target)
    marks.unshift(mark)
  }
  return marks
}

/** Undo every highlight this module made, restoring the original text nodes. */
export function clearHighlights(root: HTMLElement): void {
  for (const mark of [...root.querySelectorAll<HTMLElement>(`mark[${ANNOTATION_ATTR}]`)]) {
    mark.replaceWith(...mark.childNodes)
  }
  root.normalize()
}

export interface HighlightResult {
  /** Threads whose anchor resolved, in the order they appear on the page. */
  placed: string[]
  /** Anchored threads whose passage is gone — shown in the discussion instead. */
  outdated: string[]
}

/**
 * Highlight every text-anchored thread on a freshly rendered page.
 *
 * Threads are placed one at a time and the projection is rebuilt for each,
 * because wrapping the previous one changed the DOM underneath. Overlapping
 * comments therefore nest rather than fight, which is what a reader expects
 * when two people highlighted the same sentence.
 */
export function highlightThreads(root: HTMLElement, threads: ReviewThread[]): HighlightResult {
  clearHighlights(root)
  const placed: string[] = []
  const outdated: string[] = []

  for (const thread of threads) {
    const anchor = thread.anchor
    if (!anchor || anchor.type !== 'text') continue
    const range = resolveTextAnchor(root, anchor)
    if (!range) {
      outdated.push(thread.threadId)
      continue
    }
    wrapRange(range, (mark) => {
      mark.setAttribute(ANNOTATION_ATTR, thread.threadId)
      mark.setAttribute('data-kn-resolved', String(thread.resolved))
      mark.setAttribute('data-kn-count', String(thread.comments.length))
      mark.setAttribute('role', 'button')
      mark.setAttribute('tabindex', '0')
      mark.setAttribute(
        'aria-label',
        `${thread.comments.length} comment${thread.comments.length === 1 ? '' : 's'} on this passage`,
      )
    })
    placed.push(thread.threadId)
  }
  return { placed, outdated }
}

/** Thread ids on the mark under a click, innermost last (overlaps nest). */
export function threadsAtEvent(target: EventTarget | null): string[] {
  const ids: string[] = []
  let el = target instanceof Element ? target.closest<HTMLElement>(`mark[${ANNOTATION_ATTR}]`) : null
  while (el) {
    const id = el.getAttribute(ANNOTATION_ATTR)
    if (id && !ids.includes(id)) ids.unshift(id)
    el = el.parentElement?.closest<HTMLElement>(`mark[${ANNOTATION_ATTR}]`) ?? null
  }
  return ids
}
