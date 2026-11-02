/**
 * Quote matching, independent of what is being searched.
 *
 * A comment on a rendered page is pinned by the passage it was left on plus a
 * little of the text around it (the W3C TextQuoteSelector shape), and is
 * re-found by searching for it. Two very different things need to run that
 * search: the DOM projection used by review mode, and the ProseMirror document
 * projection used by the page reader. They agree on the answer only if they
 * agree on the algorithm — so the algorithm lives here, over a plain string,
 * and each caller supplies its own text plus a map back to its own positions.
 */
import type { ReviewThreadAnchor } from '@knowledge/contracts'
import { normalizeQuote } from '@knowledge/editor-schema/suggestions'

export type TextAnchor = Extract<ReviewThreadAnchor, { type: 'text' }>

/**
 * The parts of an anchor this search actually reads. Glossary exclusions carry
 * no `revisionId` — an exclusion is about the words, not a version of them —
 * and nothing here ever needed one.
 */
export type QuoteAnchor = Pick<TextAnchor, 'quote' | 'prefix' | 'suffix'>

/** Context kept on each side of the quote to tell repeated passages apart. */
export const CONTEXT_CHARS = 48

/** Mirrors MAX_QUOTE_CHARS in the API's ThreadAnchorDto. */
export const MAX_QUOTE_CHARS = 1_000
export const MIN_QUOTE_CHARS = 2

// One spelling for every quote search, the editor's and the API's draft tools' (#316).
export { normalizeQuote }

/**
 * How many characters of the recorded context still match around a candidate.
 *
 * Both sides go through `normalizeQuote`, and that symmetry is the whole point.
 * The stored context is normalized on write — which trims it — while the live
 * text is not, so comparing them raw fails at the very first character whenever
 * the quote sits at a word boundary: the recorded prefix ends `…OrderHub:` and
 * the live text ends `…OrderHub: `. That is nearly every anchor, and the effect
 * was silent — every candidate scored 0 and `findAnchor` kept the first, so a
 * word repeated on a page resolved to its first occurrence no matter which one
 * was recorded. The two extra characters give the trim something to remove.
 */
function contextScore(text: string, at: number, length: number, anchor: QuoteAnchor): number {
  let score = 0
  if (anchor.prefix) {
    const want = normalizeQuote(anchor.prefix)
    const have = normalizeQuote(text.slice(Math.max(0, at - want.length - 2), at))
    while (score < want.length && have[have.length - 1 - score] === want[want.length - 1 - score]) score++
  }
  if (anchor.suffix) {
    const want = normalizeQuote(anchor.suffix)
    const have = normalizeQuote(text.slice(at + length, at + length + want.length + 2))
    let i = 0
    while (i < want.length && have[i] === want[i]) i++
    score += i
  }
  return score
}

/**
 * Where the anchor points in `text`, or -1 when the passage is gone.
 *
 * Ambiguity is resolved by context, so a term repeated ten times on a page
 * still resolves to the occurrence someone actually commented on. When nothing
 * matches, the caller reports the thread outdated rather than re-attaching it
 * to text nobody reviewed — a silently moved comment is worse than a missing
 * one.
 */
export function findAnchor(text: string, anchor: QuoteAnchor): number {
  const quote = normalizeQuote(anchor.quote)
  if (!quote) return -1

  let best = -1
  let bestScore = -1
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
    const score = contextScore(text, at, quote.length, anchor)
    if (score > bestScore) {
      bestScore = score
      best = at
    }
  }
  return best
}

/** The context an anchor should record for a match at `start`. */
export function contextAround(text: string, start: number, length: number): { prefix: string; suffix: string } {
  return {
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(start + length, start + length + CONTEXT_CHARS),
  }
}

/**
 * Where lines `span` of `before` now sit in `after` (#708): a passage link
 * pinned to an older revision, opened on a newer head. The pinned lines are the
 * quote, the lines around them the context — `findAnchor` over both bodies
 * with whitespace collapsed, so moved and re-indented text still matches and
 * edited text does not. Null when the passage is gone: never a nearby guess.
 */
export function relocateLines(
  before: string,
  after: string,
  span: { start: number; end: number },
): { start: number; end: number } | null {
  const old = before.split('\n')
  if (span.end > old.length) return null
  const text = (lines: string[]) => normalizeQuote(lines.join('\n'))
  const quote = text(old.slice(span.start - 1, span.end))
  if (!quote) return null

  // The new body as one normalized string, remembering where each line starts.
  const starts: number[] = []
  let flat = ''
  for (const line of after.split('\n')) {
    const n = normalizeQuote(line)
    starts.push(n ? flat.length + (flat ? 1 : 0) : -1)
    if (n) flat += (flat ? ' ' : '') + n
  }
  const at = findAnchor(flat, {
    quote,
    prefix: text(old.slice(0, span.start - 1)).slice(-CONTEXT_CHARS),
    suffix: text(old.slice(span.end)).slice(0, CONTEXT_CHARS),
  })
  if (at < 0) return null
  const lineOf = (offset: number) => {
    let line = 0
    starts.forEach((s, i) => {
      if (s !== -1 && s <= offset) line = i
    })
    return line + 1
  }
  return { start: lineOf(at), end: lineOf(at + quote.length - 1) }
}
