/**
 * The assistant writing into the page (docs/features/34).
 *
 * An `edit_draft` call streams here as it is written: the text is real document
 * content from the first word — so it reads, wraps and renders exactly as it
 * will once kept — but it is a *suggestion* until the author accepts it. Three
 * things make that true:
 *
 * - **Serialization skips it.** `serializeWithoutSuggestions` restores every
 *   pending range to what was there before, so the working copy, a save and the
 *   draft the next turn is grounded in never contain words the author has not
 *   kept. A reload loses a suggestion; it never quietly adopts one.
 * - **History skips it.** Streaming steps are `addToHistory: false`, so undo
 *   walks the author's own edits. Discard is how a suggestion is undone.
 * - **Discard restores the slice.** Each suggestion carries the exact slice it
 *   replaced, mapped through every later transaction.
 *
 * The motion is the one authored moment of the feature: each newly revealed
 * run of text resolves from a tinted blur into ink. Those runs are tracked as
 * *text offsets* into the suggestion rather than document positions, because
 * the paragraph being written is replaced on every frame and a position inside
 * a replaced range collapses to its edge. The decoration carries a negative
 * `animation-delay` equal to the run's age, so a span ProseMirror re-creates
 * mid-fade resumes where it was instead of starting over.
 */
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { DOMParser as PMDOMParser, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { AssistantDraftEdit } from '@knowledge/contracts'
import { draftEditNeedsAnchor } from '@knowledge/contracts'
import { markdownToHtml } from '@/lib/markdown/render'
import { normalizeQuote } from '@/lib/anchor-match'
import { REVEAL_MS, type RevealRun } from '@/lib/stream-reveal'
import { projectDoc } from './comment-anchors'

/** Text offsets into the suggestion's own text — its text nodes, concatenated. */
type FreshRun = RevealRun

/** Characters of text inside a range, counting text nodes only — the unit a run is measured in. */
function textLength(doc: PMNode, from: number, to: number): number {
  let length = 0
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true
    length += Math.min(pos + node.nodeSize, to) - Math.max(pos, from)
    return false
  })
  return length
}

export interface AiSuggestion {
  id: string
  from: number
  to: number
  /** What the range held before the suggestion — Discard puts this back. */
  original: Slice
  /** Plain text of `original`, for the removal widget when the suggestion is a deletion. */
  originalText: string
  state: 'streaming' | 'ready'
  /** Text length already shown, so the next frame knows what is new. */
  shownText: number
  fresh: FreshRun[]
}

interface PluginState {
  items: AiSuggestion[]
  decorations: DecorationSet
}

type Meta =
  | { type: 'upsert'; suggestion: AiSuggestion }
  | { type: 'remove'; ids: string[] }
  | { type: 'settle' }

export const aiSuggestionsKey = new PluginKey<PluginState>('knAiSuggestions')

export interface AiSuggestionsOptions {
  t: (key: string, values?: Record<string, unknown>) => string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    aiSuggestions: {
      /** Apply one streamed `draft-edit` frame. */
      applyAiEdit: (edit: AssistantDraftEdit) => ReturnType
      /** Keep suggestions (all when no ids). */
      acceptAiSuggestions: (ids?: string[]) => ReturnType
      /** Put back what suggestions replaced (all when no ids). */
      discardAiSuggestions: (ids?: string[]) => ReturnType
      /** The turn ended: anything still streaming becomes a finished suggestion. */
      settleAiSuggestions: () => ReturnType
    }
  }
}

/* ------------------------------------------------------------- parsing */

let inert: Document | null = null
/** Parsed off-document so a suggested image does not start loading mid-stream. */
function inertDocument(): Document {
  inert ??= document.implementation.createHTMLDocument('')
  return inert
}

function markdownToFragment(markdown: string, schema: Schema): Fragment {
  if (!markdown.trim()) return Fragment.empty
  const container = inertDocument().createElement('div')
  container.innerHTML = markdownToHtml(markdown)
  return PMDOMParser.fromSchema(schema).parse(container).content
}

function markdownToText(markdown: string): string {
  const container = inertDocument().createElement('div')
  container.innerHTML = markdownToHtml(markdown)
  return normalizeQuote(container.textContent ?? '')
}

/* ------------------------------------------------------------- anchors */

/** Start and end of the top-level block holding `pos`. */
function topBlock(doc: PMNode, pos: number): { from: number; to: number } {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size))
  if ($pos.depth === 0) {
    const node = doc.childAfter($pos.pos)
    return { from: node.offset, to: node.offset + (node.node?.nodeSize ?? 0) }
  }
  return { from: $pos.before(1), to: $pos.after(1) }
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
export function resolveAnchorBlocks(doc: PMNode, anchor: string): { from: number; to: number } | null {
  const quote = markdownToText(anchor)
  if (!quote) return null
  const projection = projectDoc(doc)
  const text = projection.text
  const find = (needle: string, from = 0) => (needle ? text.indexOf(needle, from) : -1)

  let start = find(quote)
  let end = start >= 0 ? start + quote.length - 1 : -1
  if (start < 0) {
    const head = quote.slice(0, 40)
    const tail = quote.slice(-40)
    start = find(head)
    if (start < 0) return null
    const tailAt = find(tail, start)
    end = tailAt >= 0 ? tailAt + tail.length - 1 : start + head.length - 1
  }
  const from = projection.positions[start]
  const to = projection.positions[end]
  if (from === undefined || to === undefined) return null
  return { from: topBlock(doc, from).from, to: topBlock(doc, to).to }
}

/** Where a new edit goes, before any of it has been written. */
function targetRange(doc: PMNode, edit: AssistantDraftEdit): { from: number; to: number } {
  const end = doc.content.size
  if (edit.op === 'rewrite') return { from: 0, to: end }
  if (!draftEditNeedsAnchor(edit.op) || !edit.anchor) return { from: end, to: end }
  const blocks = resolveAnchorBlocks(doc, edit.anchor)
  // The server already checked this quote against the markdown, so a miss
  // here is a rendering difference, not a bad edit. The page's end is a
  // visible, discardable place to put it — dropping it would lose the work.
  if (!blocks) return { from: end, to: end }
  if (edit.op === 'insert_after') return { from: blocks.to, to: blocks.to }
  if (edit.op === 'insert_before') return { from: blocks.from, to: blocks.from }
  return blocks
}

/* ------------------------------------------------------------- applying */

/**
 * Writes the suggestion's current markdown over its range, touching only what
 * changed. Top-level nodes identical to the ones already there are kept, so
 * ProseMirror reuses their DOM and only the paragraph being written re-renders.
 */
function writeSuggestion(tr: Transaction, item: AiSuggestion, markdown: string): AiSuggestion {
  const schema = tr.doc.type.schema
  const next = markdownToFragment(markdown, schema)
  const current = tr.doc.slice(item.from, item.to).content

  let offset = 0
  let same = 0
  while (same < next.childCount && same < current.childCount && next.child(same).eq(current.child(same))) {
    offset += next.child(same).nodeSize
    same += 1
  }
  if (same < next.childCount || same < current.childCount) {
    const rest: PMNode[] = []
    for (let i = same; i < next.childCount; i++) rest.push(next.child(i))
    tr.replaceWith(item.from + offset, item.to, rest)
  }
  const to = item.from + next.size

  const length = textLength(tr.doc, item.from, to)
  const now = Date.now()
  const fresh = item.fresh.filter((run) => now - run.at < REVEAL_MS)
  if (length > item.shownText) fresh.push({ start: item.shownText, end: length, at: now })
  return { ...item, to, shownText: Math.max(item.shownText, length), fresh }
}

function upsert(state: EditorState, edit: AssistantDraftEdit): Transaction | null {
  const tr = state.tr
  tr.setMeta('addToHistory', false)
  const known = aiSuggestionsKey.getState(state)?.items.find((s) => s.id === edit.id)

  if (edit.state === 'rejected') {
    if (!known) return null
    tr.replace(known.from, known.to, known.original)
    tr.setMeta(aiSuggestionsKey, { type: 'remove', ids: [known.id] } satisfies Meta)
    return tr
  }

  let item = known
  if (!item) {
    const range = targetRange(state.doc, edit)
    const original = state.doc.slice(range.from, range.to)
    item = {
      id: edit.id,
      from: range.from,
      to: range.to,
      original,
      originalText: normalizeQuote(state.doc.textBetween(range.from, range.to, ' ')),
      state: 'streaming',
      shownText: 0,
      fresh: [],
    }
    // An insertion is written into a range that starts empty; a replacement
    // clears the old blocks on its first frame, so the new text grows into the
    // space rather than appearing after them.
  }
  const written = writeSuggestion(tr, item, edit.markdown)
  tr.setMeta(aiSuggestionsKey, {
    type: 'upsert',
    suggestion: { ...written, state: edit.state === 'ready' ? 'ready' : 'streaming' },
  } satisfies Meta)
  return tr
}

/**
 * The document as it would be with every suggestion discarded — what the
 * working copy, a save and the next turn's draft are made from.
 */
export function withoutSuggestions(state: EditorState): PMNode {
  const items = aiSuggestionsKey.getState(state)?.items ?? []
  if (items.length === 0) return state.doc
  const tr = state.tr
  for (const item of [...items].sort((a, b) => b.from - a.from)) tr.replace(item.from, item.to, item.original)
  return tr.doc
}

export function pendingSuggestions(state: EditorState): AiSuggestion[] {
  return aiSuggestionsKey.getState(state)?.items ?? []
}

/**
 * Keep suggestions — as the author's own edit.
 *
 * The text went in outside history, so simply dropping the markers would leave
 * a kept paragraph that ⌘Z cannot take back. Instead the range is quietly put
 * back to what it was, then the kept content is written over it as an ordinary
 * edit: two transactions in one tick, nothing painted between them, and undo
 * afterwards returns exactly the page from before the suggestion.
 */
function keep(view: EditorView, ids?: string[]): boolean {
  const items = pendingSuggestions(view.state)
    .filter((i) => !ids || ids.includes(i.id))
    .sort((a, b) => b.from - a.from)
  if (items.length === 0) return false
  const kept = items.map((i) => view.state.doc.slice(i.from, i.to))

  const back = view.state.tr.setMeta('addToHistory', false)
  for (const item of items) back.replace(item.from, item.to, item.original)
  view.dispatch(back)

  const tr = view.state.tr
  items.forEach((item, at) => {
    const from = back.mapping.map(item.from, -1)
    tr.replace(from, from + item.original.size, kept[at])
  })
  tr.setMeta(aiSuggestionsKey, { type: 'remove', ids: items.map((i) => i.id) } satisfies Meta)
  tr.setMeta('knAiResolved', true)
  view.dispatch(tr)
  return true
}

/* ------------------------------------------------------------- drawing */

const ICON_CHECK = '<path d="M20 6 9 17l-5-5"/>'
const ICON_X = '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'

function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
}

/** Accept / Discard under a finished suggestion. Plain DOM: a widget cannot host a Vue tree cheaply. */
function actionBar(editor: Editor, item: AiSuggestion, t: AiSuggestionsOptions['t']): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'kn-ai-actions'
  bar.contentEditable = 'false'
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', t('editorAi.suggestionActions'))

  if (item.from === item.to && item.originalText) {
    const removed = document.createElement('del')
    removed.className = 'kn-ai-removed'
    removed.textContent = item.originalText.length > 160 ? `${item.originalText.slice(0, 160)}…` : item.originalText
    bar.appendChild(removed)
  }

  const button = (label: string, svg: string, cls: string, run: () => void) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = cls
    el.innerHTML = `${icon(svg)}<span>${label}</span>`
    // mousedown, not click: a click would first move the selection into the
    // widget's neighbour and scroll the page under the pointer.
    el.addEventListener('mousedown', (event) => {
      event.preventDefault()
      run()
    })
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        run()
      }
    })
    return el
  }
  bar.appendChild(
    button(t('editorAi.accept'), ICON_CHECK, 'kn-ai-accept', () =>
      editor.chain().acceptAiSuggestions([item.id]).focus().run(),
    ),
  )
  bar.appendChild(
    button(t('editorAi.discard'), ICON_X, 'kn-ai-discard', () =>
      editor.chain().discardAiSuggestions([item.id]).focus().run(),
    ),
  )
  return bar
}

/** Document ranges covering a run of the suggestion's text — one per text node it crosses. */
function runRanges(doc: PMNode, item: AiSuggestion, run: FreshRun): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let seen = 0
  doc.nodesBetween(item.from, item.to, (node, pos) => {
    if (!node.isText) return seen < run.end
    const from = Math.max(pos, item.from)
    const to = Math.min(pos + node.nodeSize, item.to)
    const lo = Math.max(run.start, seen)
    const hi = Math.min(run.end, seen + (to - from))
    if (hi > lo) out.push({ from: from + (lo - seen), to: from + (hi - seen) })
    seen += to - from
    return false
  })
  return out
}

/** Just past the last character of text in a range — where the caret belongs while writing. */
function lastTextEnd(doc: PMNode, from: number, to: number): number {
  let end = to
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) end = Math.min(pos + node.nodeSize, to)
    else if (node.isTextblock && node.content.size === 0) end = pos + 1
    return !node.isText
  })
  return end
}

function buildDecorations(editor: Editor, state: EditorState, items: AiSuggestion[], t: AiSuggestionsOptions['t']) {
  const decorations: Decoration[] = []
  const now = Date.now()
  for (const item of items) {
    const streaming = item.state === 'streaming'
    state.doc.nodesBetween(item.from, item.to, (node, pos) => {
      if (pos >= item.from && pos + node.nodeSize <= item.to) {
        decorations.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: 'kn-ai-block',
            'data-ai-state': item.state,
            'data-ai-suggestion': item.id,
          }),
        )
      }
      return false
    })
    for (const run of item.fresh) {
      const age = now - run.at
      if (age >= REVEAL_MS) continue
      for (const range of runRanges(state.doc, item, run)) {
        decorations.push(
          Decoration.inline(range.from, range.to, { class: 'kn-reveal', style: `animation-delay:-${age}ms` }),
        )
      }
    }
    if (streaming) {
      decorations.push(
        Decoration.widget(lastTextEnd(state.doc, item.from, item.to), () => {
          const caret = document.createElement('span')
          caret.className = 'kn-ai-caret'
          caret.setAttribute('aria-hidden', 'true')
          return caret
        }, { side: 1, key: `caret-${item.id}` }),
      )
    } else {
      decorations.push(
        Decoration.widget(item.to, () => actionBar(editor, item, t), {
          side: 1,
          key: `actions-${item.id}`,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      )
    }
  }
  return DecorationSet.create(state.doc, decorations)
}

/* ------------------------------------------------------------- following */

/**
 * Keeps the text being written in view — until the author scrolls, which is
 * them saying they are reading something else. They get it back on the next
 * suggestion.
 */
function follower(view: EditorView) {
  let released = false
  let lastId: string | null = null
  const scroller = view.dom.closest('.kn-editor-surface') as HTMLElement | null
  const release = () => {
    released = true
  }
  scroller?.addEventListener('wheel', release, { passive: true })
  scroller?.addEventListener('touchmove', release, { passive: true })
  return {
    update(view: EditorView) {
      const items = aiSuggestionsKey.getState(view.state)?.items ?? []
      const live = items.find((i) => i.state === 'streaming')
      if (!live || !scroller) return
      if (live.id !== lastId) {
        lastId = live.id
        released = false
      }
      if (released) return
      const end = view.coordsAtPos(Math.min(live.to, view.state.doc.content.size))
      const box = scroller.getBoundingClientRect()
      const margin = 96
      if (end.bottom > box.bottom - margin) scroller.scrollTop += end.bottom - (box.bottom - margin)
      else if (end.top < box.top + margin) scroller.scrollTop -= box.top + margin - end.top
    },
    destroy() {
      scroller?.removeEventListener('wheel', release)
      scroller?.removeEventListener('touchmove', release)
    },
  }
}

/* ------------------------------------------------------------- extension */

export const AiSuggestions = Extension.create<AiSuggestionsOptions>({
  name: 'aiSuggestions',

  addOptions() {
    return { t: (key: string) => key }
  },

  addCommands() {
    return {
      applyAiEdit:
        (edit) =>
        ({ state, dispatch }) => {
          const tr = upsert(state, edit)
          if (!tr) return false
          dispatch?.(tr)
          return true
        },
      acceptAiSuggestions:
        (ids) =>
        ({ state, view, tr, dispatch }) => {
          if (!dispatch) return pendingSuggestions(state).some((i) => !ids || ids.includes(i.id))
          // Two transactions of its own (see `keep`). The command's shared one
          // was built on the document before them, and dispatching it after
          // would be a mismatched transaction — so it is told not to.
          tr.setMeta('preventDispatch', true)
          return keep(view, ids)
        },
      discardAiSuggestions:
        (ids) =>
        ({ state, tr, dispatch }) => {
          const items = pendingSuggestions(state).filter((i) => !ids || ids.includes(i.id))
          if (items.length === 0) return false
          tr.setMeta('addToHistory', false)
          for (const item of [...items].sort((a, b) => b.from - a.from)) {
            const from = tr.mapping.map(item.from, -1)
            const to = tr.mapping.map(item.to, 1)
            tr.replace(from, to, item.original)
          }
          tr.setMeta(aiSuggestionsKey, { type: 'remove', ids: items.map((i) => i.id) } satisfies Meta)
          tr.setMeta('knAiResolved', true)
          dispatch?.(tr)
          return true
        },
      settleAiSuggestions:
        () =>
        ({ state, tr, dispatch }) => {
          if (!pendingSuggestions(state).some((i) => i.state === 'streaming')) return false
          tr.setMeta(aiSuggestionsKey, { type: 'settle' } satisfies Meta)
          tr.setMeta('addToHistory', false)
          dispatch?.(tr)
          return true
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      // Keep everything the assistant suggested — only once it has finished
      // writing, so a stray chord mid-stream cannot adopt half a sentence.
      'Mod-Enter': ({ editor }) => {
        const items = pendingSuggestions(editor.state)
        if (items.length === 0 || items.some((i) => i.state === 'streaming')) return false
        return editor.commands.acceptAiSuggestions()
      },
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const t = this.options.t
    return [
      new Plugin<PluginState>({
        key: aiSuggestionsKey,
        state: {
          init: () => ({ items: [], decorations: DecorationSet.empty }),
          apply(tr, prev, _old, next) {
            const meta = tr.getMeta(aiSuggestionsKey) as Meta | undefined
            let items = prev.items
            if (tr.docChanged) {
              // Inward: text typed right at a suggestion's edge is the
              // author's, not part of the suggestion. A replacement covering
              // the range still maps its ends to the new content's edges.
              items = items
                .filter((i) => meta?.type !== 'upsert' || i.id !== meta.suggestion.id)
                .map((i) => {
                  const from = tr.mapping.map(i.from, 1)
                  const to = Math.max(from, tr.mapping.map(i.to, -1))
                  return { ...i, from, to }
                })
                .filter((i) => i.to > i.from || i.originalText.length > 0 || i.state === 'streaming')
            }
            if (meta?.type === 'upsert') {
              items = [...items.filter((i) => i.id !== meta.suggestion.id), meta.suggestion].sort(
                (a, b) => a.from - b.from,
              )
            } else if (meta?.type === 'remove') {
              items = items.filter((i) => !meta.ids.includes(i.id))
            } else if (meta?.type === 'settle') {
              items = items.map((i) => (i.state === 'streaming' ? { ...i, state: 'ready' as const } : i))
            }
            if (items === prev.items && !tr.docChanged) return prev
            if (items.length === 0) return { items, decorations: DecorationSet.empty }
            return { items, decorations: buildDecorations(editor, next, items, t) }
          },
        },
        props: {
          decorations: (state) => aiSuggestionsKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
        view: follower,
      }),
    ]
  },
})
