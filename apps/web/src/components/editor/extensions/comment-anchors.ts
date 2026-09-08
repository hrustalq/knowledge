/**
 * Comment highlights inside the editor (feature 15).
 *
 * Review mode wraps commented passages in `<mark>` elements it injects into the
 * rendered HTML. That cannot work here: the page reader is the editor itself,
 * and ProseMirror owns its DOM — anything written into it from outside is
 * liable to be reconciled away. So the same highlights are expressed the way
 * ProseMirror expects, as inline decorations over document positions, which
 * also means they survive an edit without being re-injected.
 *
 * Positions come from a projection of the document's text that matches the DOM
 * projection in `text-anchor.ts` character for character — whitespace
 * collapsed, one synthetic space at every block boundary — so a quote captured
 * from a browser selection resolves against the document, and an anchor written
 * by review mode resolves here.
 */
import { Decoration, Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  contextAround,
  findAnchor,
  normalizeQuote,
  type TextAnchor,
} from '@/lib/anchor-match'

/** One commented passage, in the shape the editor needs to draw it. */
export interface CommentAnchor {
  id: string
  anchor: TextAnchor
  resolved: boolean
  /** Comment count, surfaced on the highlight as a pin. */
  count: number
}

export interface CommentAnchorsStorage {
  anchors: CommentAnchor[]
  /** Anchors whose passage is no longer in the document, after the last pass. */
  outdated: string[]
}

declare module '@tiptap/core' {
  interface Storage {
    commentAnchors: CommentAnchorsStorage
  }
  interface Commands<ReturnType> {
    commentAnchors: {
      /** Replace the highlighted set and redraw. */
      setCommentAnchors: (anchors: CommentAnchor[]) => ReturnType
    }
  }
}

export const ANCHOR_ATTR = 'data-kn-thread'

interface Projection {
  /** Visible text, whitespace collapsed to single spaces. */
  text: string
  /** positions[i] is the document position of text[i]. */
  positions: number[]
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
  let text = ''
  const positions: number[] = []
  let pendingSpace = false

  doc.descendants((node, pos) => {
    if (node.isText) {
      const raw = node.text ?? ''
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i]!
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
          pendingSpace = text.length > 0
          continue
        }
        if (pendingSpace) {
          text += ' '
          positions.push(pos + i)
          pendingSpace = false
        }
        text += ch
        positions.push(pos + i)
      }
      return false
    }
    // Entering any block starts a new run of text. Atom blocks (a diagram, a
    // whiteboard) hold no prose the reader can quote, so they only break.
    if (node.isBlock) pendingSpace = text.length > 0
    return !node.isAtom
  })

  return { text, positions }
}

/** Document range for an anchor, or null when the passage is gone. */
export function resolveAnchorInDoc(doc: PMNode, anchor: TextAnchor): { from: number; to: number } | null {
  const quote = normalizeQuote(anchor.quote)
  if (!quote) return null
  const projection = projectDoc(doc)
  const at = findAnchor(projection.text, anchor)
  if (at < 0) return null
  const from = projection.positions[at]
  const last = projection.positions[at + quote.length - 1]
  if (from === undefined || last === undefined) return null
  return { from, to: last + 1 }
}

/**
 * Build an anchor for a passage of text, located in the document.
 *
 * Everything but the raw string comes from the document projection, and that is
 * the guard that matters: text the document has no record of (a diagram's
 * rendered labels, the comment UI) yields no match, and returning null lets the
 * caller offer an unanchored comment rather than store a pin that will never be
 * found again.
 */
export function anchorFromQuote(doc: PMNode, revisionId: string, raw: string): TextAnchor | null {
  const quote = normalizeQuote(raw).slice(0, MAX_QUOTE_CHARS)
  if (quote.length < MIN_QUOTE_CHARS) return null

  const projection = projectDoc(doc)
  const start = projection.text.indexOf(quote)
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
 * The same, from whatever the reader has selected. The quote comes from the
 * browser selection because a read-only editor keeps no ProseMirror selection
 * to read.
 */
export function anchorFromDomSelection(doc: PMNode, revisionId: string): TextAnchor | null {
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  return anchorFromQuote(doc, revisionId, selection.toString())
}

export const CommentAnchors = Extension.create<Record<string, never>, CommentAnchorsStorage>({
  name: 'commentAnchors',

  addStorage() {
    return { anchors: [], outdated: [] }
  },

  addCommands() {
    return {
      setCommentAnchors:
        (anchors: CommentAnchor[]) =>
        ({ editor, commands }) => {
          editor.storage.commentAnchors.anchors = anchors
          return commands.updateDecorations('commentAnchors')
        },
    }
  },

  addDecorations() {
    return {
      // The anchor set changes when someone comments, not when the document
      // changes, so redraws are driven by the command rather than by every
      // keystroke.
      update: 'manual',
      create: ({ editor, state }) => {
        const storage = editor.storage.commentAnchors
        const decorations: Decoration[] = []
        const outdated: string[] = []

        for (const entry of storage.anchors) {
          const range = resolveAnchorInDoc(state.doc, entry.anchor)
          if (!range) {
            outdated.push(entry.id)
            continue
          }
          const label = `${entry.count} comment${entry.count === 1 ? '' : 's'} on this passage`
          decorations.push(
            Decoration.Inline(range.from, range.to, {
              class: entry.resolved ? 'kn-anchor kn-anchor-resolved' : 'kn-anchor',
              [ANCHOR_ATTR]: entry.id,
              role: 'button',
              tabindex: '0',
              'aria-label': label,
            }),
          )
          // The count is a widget, not `::after` on the highlight: ProseMirror
          // splits one inline decoration into a span per text node, so a pin
          // drawn in CSS appears once per fragment — and no selector can tell
          // "this thread continues" from "a different thread starts here",
          // which is exactly what two comments on neighbouring passages look
          // like. A widget is one node at one position, by construction.
          decorations.push(
            Decoration.Widget(
              range.to,
              () => {
                const pin = document.createElement('span')
                pin.className = entry.resolved ? 'kn-anchor-pin kn-anchor-pin-resolved' : 'kn-anchor-pin'
                pin.contentEditable = 'false'
                pin.textContent = String(entry.count)
                pin.setAttribute(ANCHOR_ATTR, entry.id)
                pin.setAttribute('role', 'button')
                pin.setAttribute('tabindex', '0')
                pin.setAttribute('aria-label', label)
                return pin
              },
              { key: `kn-pin-${entry.id}-${entry.count}-${entry.resolved}`, side: 1 },
            ),
          )
        }

        storage.outdated = outdated
        return decorations
      },
    }
  },
})

/** Thread ids on the highlight under a click, innermost last (overlaps nest). */
export function anchorsAtEvent(target: EventTarget | null): string[] {
  const ids: string[] = []
  let el = target instanceof Element ? target.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) : null
  while (el) {
    const id = el.getAttribute(ANCHOR_ATTR)
    if (id && !ids.includes(id)) ids.unshift(id)
    el = el.parentElement?.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) ?? null
  }
  return ids
}
