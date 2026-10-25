import type { AnswerCitation, AssistantAskSource, AssistantSource } from '@knowledge/contracts'
import { isWebSource } from '@knowledge/contracts'
import { slugifyHeading } from '@/lib/markdown/render'

// In a leaf of its own so the tree rows' dots do not pull in the markdown renderer (#279).
export { verificationTone } from '@/lib/verification-tone'

/**
 * Sentence-level citations on the read side (docs/features/38).
 *
 * The API stores an answer with `[S2]`-style markers and a `cite` label on each
 * source; this is where a marker becomes something a reader can hover and click.
 * The marker grammar here must match `apps/api/src/assistant/citations.ts` —
 * the API normalizes to `[S1, S3]`, and this accepts that plus the looser forms
 * a stream delivers before the API has had its say.
 */
export const CITE_MARKER_RE = /\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/gi

/** `[S1, S3]` → `['S1', 'S3']`. */
export function citeLabels(marker: string): string[] {
  return marker
    .replace(/^\[|\]$/g, '')
    .split(/[,;]/)
    .map((l) => l.trim().toUpperCase())
    .filter((l) => /^S\d+$/.test(l))
}

/** `S3` → 3, the number the reader sees. */
export function citeNumber(label: string): number {
  return Number(label.replace(/^S/i, '')) || 0
}

export function sourceByCite(sources: readonly AssistantSource[], label: string): AssistantSource | undefined {
  return sources.find((s) => s.cite === label)
}

/** The in-page anchor MarkdownView gives the chunk's last heading, or '' for the top. */
export function headingAnchor(headingPath?: readonly string[]): string {
  const last = headingPath?.at(-1)
  return last ? slugifyHeading(last) : ''
}

/** Where a page citation opens: the page, at the cited section when one is known. */
export function sourceHref(source: AssistantAskSource): string {
  const anchor = headingAnchor(source.headingPath)
  return `/documents/${source.documentId}${anchor ? `#${anchor}` : ''}`
}

const SKIP = new Set(['PRE', 'CODE', 'A', 'BUTTON', 'SCRIPT', 'STYLE', 'TEXTAREA'])

/**
 * Replace every `[S#]` marker in the rendered answer with a superscript button
 * carrying `data-cite`. Runs after each render, including streaming ones, so a
 * marker that arrived mid-stream is already a chip; `known` says which labels
 * resolve to a source — the rest are drawn neutral (pending) rather than as
 * links to nothing. Returns how many markers were decorated.
 *
 * A DOM pass rather than a markdown extension because the renderer is shared
 * with pages and comments, where `[S1]` is just text.
 */
export function decorateCitations(root: HTMLElement, known?: ReadonlySet<string>): number {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !/\[\s*S\d/i.test(node.nodeValue)) return NodeFilter.FILTER_REJECT
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        if (SKIP.has(el.tagName) || el.classList.contains('kn-cites')) return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const targets: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text)

  let count = 0
  for (const text of targets) {
    const value = text.nodeValue ?? ''
    const re = new RegExp(CITE_MARKER_RE.source, 'gi')
    const frag = root.ownerDocument.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(value))) {
      const labels = citeLabels(m[0])
      if (labels.length === 0) continue
      // The space the API left before the marker is swallowed: a superscript
      // sits against the word, as a footnote mark does.
      frag.append(value.slice(last, m.index).replace(/[ \t]+$/, ''))
      const sup = root.ownerDocument.createElement('sup')
      sup.className = 'kn-cites'
      for (const label of labels) {
        const btn = root.ownerDocument.createElement('button')
        btn.type = 'button'
        btn.className = 'kn-cite' + (known && !known.has(label) ? ' kn-cite-pending' : '')
        btn.dataset.cite = label
        btn.textContent = String(citeNumber(label))
        sup.append(btn)
        count++
      }
      frag.append(sup)
      last = m.index + m[0].length
    }
    if (last === 0) continue
    frag.append(value.slice(last))
    text.replaceWith(frag)
  }
  return count
}

/** Fenced blocks and inline code: where neither the API nor `decorateCitations` reads a marker. */
const CODE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))|`[^`\n]+`/gm

/**
 * Which markers, counted in the order `decorateCitations` draws them, close a
 * sentence the decision model marked unsupported (#530). Counted from the
 * stored text: a citation's offsets are into it, and code is skipped on both
 * sides, so the n-th marker here is the n-th `.kn-cites` there.
 */
export function unsupportedMarkers(content: string, citations: readonly AnswerCitation[] | undefined): Set<number> {
  const out = new Set<number>()
  const flagged = (citations ?? []).filter((c) => c.support === 'unsupported')
  if (!flagged.length) return out
  const code: Array<[number, number]> = []
  for (const m of content.matchAll(CODE_RE)) code.push([m.index, m.index + m[0].length])
  let n = 0
  for (const m of content.matchAll(new RegExp(CITE_MARKER_RE.source, 'gi'))) {
    if (code.some(([a, b]) => m.index >= a && m.index < b) || citeLabels(m[0]).length === 0) continue
    if (flagged.some((c) => m.index >= c.start && m.index < c.end)) out.add(n)
    n++
  }
  return out
}

/**
 * Draw the unsupported marks on an already decorated answer: idempotent, so it
 * runs after every render and again when the marks arrive after the text did.
 * `label` is what a screen reader and a hover hear; the dashed caution ring is
 * the visible half, so the mark is never colour alone.
 */
export function markUnsupported(root: HTMLElement | null, markers: ReadonlySet<number>, label: string): void {
  if (!root) return
  root.querySelectorAll<HTMLElement>('.kn-cites').forEach((sup, i) => {
    const on = markers.has(i)
    sup.classList.toggle('kn-cites-unsupported', on)
    for (const btn of sup.querySelectorAll<HTMLElement>('.kn-cite')) {
      if (on) btn.title = label
      else btn.removeAttribute('title')
      if (on) btn.setAttribute('aria-description', label)
      else btn.removeAttribute('aria-description')
    }
  })
}

/** Toggle the hover/focus highlight on every marker for one label. */
export function highlightCite(root: HTMLElement | null, label: string | null): void {
  if (!root) return
  for (const el of root.querySelectorAll<HTMLElement>('.kn-cite')) {
    el.classList.toggle('kn-cite-active', label !== null && el.dataset.cite === label)
  }
}

/** The label a pointer or focus event landed on, if it landed on a marker. */
export function citeOfEvent(event: Event): string | null {
  const el = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.kn-cite')
  return el?.dataset.cite ?? null
}

export { isWebSource }
