/**
 * Newly streamed text resolving into place (docs/features/34).
 *
 * A streamed reply is re-rendered whole on every token, since markdown cannot
 * be parsed a piece at a time: `**bo` only becomes bold once `ld**` arrives.
 * So "what is new" cannot be a DOM node. It is a span of *text offsets*: the
 * characters past what the reader had already seen. After each render those
 * offsets are wrapped in a span that runs the entrance, and the span carries a
 * negative `animation-delay` equal to its age, so text re-rendered mid-fade
 * picks up where it was instead of starting again. Replaying a fade on every
 * token is what makes a stream flicker.
 *
 * The editor's suggestions do the same thing with ProseMirror decorations
 * (`extensions/ai-suggestions.ts`); both draw `.kn-reveal`, so a reply and the
 * page it is writing into arrive the same way.
 */

export interface RevealRun {
  start: number
  end: number
  at: number
}

/** Longer than the CSS entrance, so a run is never dropped while it is still moving. */
export const REVEAL_MS = 900

export function createRevealTracker() {
  let shown = 0
  let runs: RevealRun[] = []
  return {
    /** Record that the text is now `total` characters long; returns the runs still animating. */
    advance(total: number, now = Date.now()): RevealRun[] {
      runs = runs.filter((run) => now - run.at < REVEAL_MS && run.start < total)
      // Text can shrink by a character or two when syntax resolves (`**` vanishing
      // into bold). Anything already seen stays seen.
      if (total > shown) runs.push({ start: shown, end: total, at: now })
      shown = Math.max(shown, total)
      return runs
    },
    reset() {
      shown = 0
      runs = []
    },
  }
}

/** Wraps each run's characters in `.kn-reveal` spans, skipping text inside code. */
export function wrapRuns(root: HTMLElement, runs: RevealRun[], now = Date.now()): void {
  if (runs.length === 0) return
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)

  let offset = 0
  for (const node of nodes) {
    const text = node.data
    const start = offset
    const end = offset + text.length
    offset = end
    if (!text || node.parentElement?.closest('pre, code')) continue
    const hits = runs.filter((run) => run.start < end && run.end > start)
    if (hits.length === 0) continue

    const frag = doc.createDocumentFragment()
    let cursor = 0
    for (const run of hits) {
      const from = Math.max(run.start - start, cursor)
      const to = Math.min(run.end - start, text.length)
      if (to <= from) continue
      if (from > cursor) frag.append(text.slice(cursor, from))
      const span = doc.createElement('span')
      span.className = 'kn-reveal'
      span.style.animationDelay = `-${now - run.at}ms`
      span.textContent = text.slice(from, to)
      frag.append(span)
      cursor = to
    }
    if (cursor < text.length) frag.append(text.slice(cursor))
    node.replaceWith(frag)
  }
}
