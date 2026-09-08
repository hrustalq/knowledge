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

export type TextAnchor = Extract<ReviewThreadAnchor, { type: 'text' }>

/** Context kept on each side of the quote to tell repeated passages apart. */
export const CONTEXT_CHARS = 48

/** Mirrors MAX_QUOTE_CHARS in the API's ThreadAnchorDto. */
export const MAX_QUOTE_CHARS = 1_000
export const MIN_QUOTE_CHARS = 2

/**
 * Whitespace as rendered is layout, not content: the same passage yields
 * different runs of spaces depending on where the line broke. Collapsing it is
 * what makes an anchor portable between viewports, renderers and clients — the
 * API normalizes identically on write.
 */
export function normalizeQuote(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** How many characters of the recorded context still match around a candidate. */
function contextScore(text: string, at: number, length: number, anchor: TextAnchor): number {
  let score = 0
  if (anchor.prefix) {
    const want = normalizeQuote(anchor.prefix)
    const have = text.slice(Math.max(0, at - want.length), at)
    while (score < want.length && have[have.length - 1 - score] === want[want.length - 1 - score]) score++
  }
  if (anchor.suffix) {
    const want = normalizeQuote(anchor.suffix)
    const have = text.slice(at + length, at + length + want.length)
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
export function findAnchor(text: string, anchor: TextAnchor): number {
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
