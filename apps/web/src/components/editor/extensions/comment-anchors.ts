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
import { avatarColorDeep, avatarInitials } from '@/lib/avatar'
import {
  MAX_QUOTE_CHARS,
  MIN_QUOTE_CHARS,
  contextAround,
  findAnchor,
  normalizeQuote,
  type TextAnchor,
} from '@/lib/anchor-match'

/** A face on a pin: who is in this discussion. */
export interface AnchorAuthor {
  userId: string
  name: string
  /** Posted by an assistant review — shown as a glyph, never as a person. */
  ai?: boolean
}

/** One commented passage, in the shape the editor needs to draw it. */
export interface CommentAnchor {
  id: string
  anchor: TextAnchor
  resolved: boolean
  /** Comment count, surfaced on the highlight as a pin. */
  count: number
  /** Distinct participants, oldest first. */
  authors?: AnchorAuthor[]
}

/** How many faces a pin shows before it stops and lets the count speak. */
const MAX_FACES = 3

const BOT_MASK =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23000' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 8V4H8'/%3E%3Crect width='16' height='12' x='4' y='8' rx='2'/%3E%3Cpath d='M2 14h2M20 14h2M15 13v2M9 13v2'/%3E%3C/svg%3E\")"

function faceEl(author: AnchorAuthor): HTMLElement {
  const face = document.createElement('span')
  face.className = 'kn-anchor-face'
  face.title = author.ai ? 'Assistant' : author.name
  if (author.ai) {
    face.classList.add('kn-anchor-face-ai')
    const glyph = document.createElement('span')
    glyph.className = 'kn-anchor-face-glyph'
    glyph.style.setProperty('-webkit-mask-image', BOT_MASK)
    glyph.style.maskImage = BOT_MASK
    face.append(glyph)
  } else {
    face.style.background = avatarColorDeep(author.userId)
    face.textContent = avatarInitials(author.name)
  }
  return face
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
/** Every thread a pin stands for, when several share one passage. */
export const ANCHOR_LIST_ATTR = 'data-kn-threads'

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

        // Threads that landed on the same passage share one pin. Two people
        // commenting on one sentence is the normal case, and a row of separate
        // badges after it reads as a rendering fault rather than as a
        // conversation — so they stack, the way a reviewer list does.
        const groups = new Map<
          string,
          { from: number; to: number; ids: string[]; count: number; resolved: boolean; authors: AnchorAuthor[] }
        >()

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

          const key = `${range.from}:${range.to}`
          const group = groups.get(key)
          if (!group) {
            groups.set(key, {
              from: range.from,
              to: range.to,
              ids: [entry.id],
              count: entry.count,
              resolved: entry.resolved,
              authors: [...(entry.authors ?? [])],
            })
          } else {
            group.ids.push(entry.id)
            group.count += entry.count
            // A passage is settled only when every discussion on it is; one
            // open thread still needs someone's attention.
            group.resolved &&= entry.resolved
            for (const a of entry.authors ?? []) {
              if (!group.authors.some((x) => (a.ai ? x.ai : x.userId === a.userId && !x.ai))) {
                group.authors.push(a)
              }
            }
          }
        }

        for (const group of groups.values()) {
          const threads = group.ids.length
          const label =
            `${group.count} comment${group.count === 1 ? '' : 's'}` +
            (threads > 1 ? ` in ${threads} discussions` : '') +
            ' on this passage'
          // The count is a widget, not `::after` on the highlight: ProseMirror
          // splits one inline decoration into a span per text node, so a pin
          // drawn in CSS appears once per fragment — and no selector can tell
          // "this thread continues" from "a different thread starts here",
          // which is exactly what two comments on neighbouring passages look
          // like. A widget is one node at one position, by construction.
          decorations.push(
            Decoration.Widget(
              group.to,
              () => {
                const pin = document.createElement('span')
                pin.className = group.resolved ? 'kn-anchor-pin kn-anchor-pin-resolved' : 'kn-anchor-pin'
                pin.contentEditable = 'false'
                // The first id positions the popover (the click handler reads
                // `closest([data-kn-thread])`); the plural attribute is what
                // actually opens the passage's whole discussion.
                pin.setAttribute(ANCHOR_ATTR, group.ids[0] as string)
                pin.setAttribute(ANCHOR_LIST_ATTR, group.ids.join(','))
                pin.setAttribute('role', 'button')
                pin.setAttribute('tabindex', '0')
                pin.setAttribute('aria-label', label)

                const faces = group.authors.slice(0, MAX_FACES)
                if (faces.length > 0) {
                  const stack = document.createElement('span')
                  stack.className = 'kn-anchor-faces'
                  for (const author of faces) stack.append(faceEl(author))
                  pin.append(stack)
                }
                const count = document.createElement('span')
                count.className = 'kn-anchor-pin-count'
                count.textContent = String(group.count)
                pin.append(count)
                return pin
              },
              {
                key: `kn-pin-${group.ids.join('.')}-${group.count}-${group.resolved}-${group.authors.length}`,
                side: 1,
              },
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
  // A stacked pin stands for every discussion on the passage, so pressing it
  // opens all of them rather than only the one that happens to be first.
  const cluster =
    target instanceof Element ? target.closest<HTMLElement>(`[${ANCHOR_LIST_ATTR}]`) : null
  if (cluster) {
    return (cluster.getAttribute(ANCHOR_LIST_ATTR) ?? '').split(',').filter(Boolean)
  }
  let el = target instanceof Element ? target.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) : null
  while (el) {
    const id = el.getAttribute(ANCHOR_ATTR)
    if (id && !ids.includes(id)) ids.unshift(id)
    el = el.parentElement?.closest<HTMLElement>(`[${ANCHOR_ATTR}]`) ?? null
  }
  return ids
}
