/**
 * The editor's events as streams — the one place a Tiptap event enters the UI.
 *
 * Why streams rather than `editor.on` in each component: nearly everything the
 * chrome around the editor does is a question of *timing*. The toolbar, the
 * selection bubble, the table bar and the drag gutter all want "the latest
 * state, at most once per frame, and only if it changed"; the model binding
 * wants "the document, once typing pauses, unless someone asks for it now".
 * Hand-written, each of those was a timer or a listener in a different file,
 * and three of them read layout synchronously inside every transaction.
 *
 * It also takes the chrome off Vue's hot path. `@tiptap/vue-3` makes
 * `editor.state` reactive, so any template that called `editor.isActive()`
 * re-rendered on *every* transaction — the whole toolbar, per keystroke, to
 * learn that bold was still off. The chrome now renders from `FormatState`,
 * a snapshot taken once per frame and dropped when nothing in it changed.
 *
 * Streams are cached per editor and ref-counted: the listeners are attached
 * while something is subscribed and removed when the last subscriber leaves.
 */
import type { Editor, EditorEvents } from '@tiptap/core'
import { DOMSerializer, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model'
import {
  Observable,
  Subject,
  animationFrameScheduler,
  auditTime,
  debounceTime,
  distinctUntilChanged,
  filter,
  map,
  merge,
  share,
  type Subscription,
} from 'rxjs'
import { htmlToMarkdown } from '@/lib/markdown/serialize'
import { canIndent, canOutdent } from './extensions/list-indent'

/** A Tiptap event as a stream. Listener attached on subscribe, removed on unsubscribe. */
export function fromEditorEvent<K extends keyof EditorEvents>(
  editor: Editor,
  event: K,
): Observable<EditorEvents[K]> {
  return new Observable<EditorEvents[K]>((subscriber) => {
    const handler = (payload: EditorEvents[K]) => subscriber.next(payload)
    // Tiptap's `on` is typed over a tuple-or-single callback shape that a
    // generic `K` cannot narrow; the runtime contract is one payload argument.
    editor.on(event, handler as never)
    return () => {
      editor.off(event, handler as never)
    }
  })
}

/** What the formatting chrome shows. Flat and primitive, so equality is cheap. */
export interface FormatState {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  highlight: boolean
  link: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
  /** 0 for body text, otherwise the heading level. */
  heading: number
  canUndo: boolean
  canRedo: boolean
  canIndent: boolean
  canOutdent: boolean
}

export const EMPTY_FORMAT: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  highlight: false,
  link: false,
  bulletList: false,
  orderedList: false,
  taskList: false,
  heading: 0,
  canUndo: false,
  canRedo: false,
  canIndent: false,
  canOutdent: false,
}

const HEADING_LEVELS = [1, 2, 3, 4] as const

/** Every `isActive`/`can()` the chrome needs, in one pass. */
export function readFormatState(editor: Editor): FormatState {
  if (editor.isDestroyed) return EMPTY_FORMAT
  const inList = editor.isActive('listItem') || editor.isActive('taskItem')
  return {
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    underline: editor.isActive('underline'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    highlight: editor.isActive('highlight'),
    link: editor.isActive('link'),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    taskList: editor.isActive('taskList'),
    heading: HEADING_LEVELS.find((level) => editor.isActive('heading', { level })) ?? 0,
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    // Each is up to two dry-run commands; outside a list the answer is known.
    canIndent: inList && canIndent(editor),
    canOutdent: inList && canOutdent(editor),
  }
}

/** Shallow equality for flat snapshots — the `distinctUntilChanged` every chrome stream uses. */
export function shallowEqual<T extends object>(a: T | null, b: T | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keys = Object.keys(a) as (keyof T)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

export interface EditorStreams {
  /** Every transaction, selection-only ones included. */
  transaction$: Observable<EditorEvents['transaction']>
  /**
   * Edits: the `update` event, which is a doc-changing transaction *not*
   * marked `preventUpdate`. Content a host loads with
   * `setContent(…, { emitUpdate: false })` changes the doc but is not an edit,
   * and echoing it back as one would rewrite the host's model on every load.
   */
  docChanged$: Observable<EditorEvents['update']>
  /**
   * "Something may have moved": transactions, focus and blur, coalesced to at
   * most one emission per animation frame. Anything that reads layout
   * (`coordsAtPos`, `getBoundingClientRect`) listens here, so a burst of
   * transactions costs one forced layout instead of one each.
   */
  frame$: Observable<void>
  /** The toolbar's view of the selection, once per frame, only when it changed. */
  format$: Observable<FormatState>
  focus$: Observable<EditorEvents['focus']>
  blur$: Observable<EditorEvents['blur']>
}

const cache = new WeakMap<Editor, EditorStreams>()

export function editorStreams(editor: Editor): EditorStreams {
  const cached = cache.get(editor)
  if (cached) return cached

  const transaction$ = fromEditorEvent(editor, 'transaction').pipe(share())
  const docChanged$ = fromEditorEvent(editor, 'update').pipe(share())
  const focus$ = fromEditorEvent(editor, 'focus').pipe(share())
  const blur$ = fromEditorEvent(editor, 'blur').pipe(share())
  const frame$ = merge(transaction$, focus$, blur$).pipe(
    auditTime(0, animationFrameScheduler),
    filter(() => !editor.isDestroyed),
    map(() => undefined),
    share(),
  )
  const format$ = frame$.pipe(
    map(() => readFormatState(editor)),
    distinctUntilChanged(shallowEqual),
    share(),
  )

  const streams: EditorStreams = { transaction$, docChanged$, frame$, format$, focus$, blur$ }
  cache.set(editor, streams)
  return streams
}

/* ------------------------------------------------------------ markdown */

let inert: Document | null = null
/**
 * A detached document to build serializer output in. Elements created in the
 * live document start loading their resources the moment `src` is set, even
 * unattached — serializing a page of images would refetch every one of them.
 */
function inertDocument(): Document {
  inert ??= document.implementation.createHTMLDocument('')
  return inert
}

/**
 * A ProseMirror document as stored markdown.
 *
 * `editor.getHTML()` builds this same DOM, flattens it to a string, and
 * turndown immediately parses the string back into a DOM. Handing turndown the
 * DOM skips a full serialize-and-parse of the page on every sync.
 */
export function docToMarkdown(doc: ProseMirrorNode, schema: Schema): string {
  const owner = inertDocument()
  const container = owner.createElement('div')
  container.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(doc.content, { document: owner }))
  return htmlToMarkdown(container)
}

export interface MarkdownSync {
  /** The markdown, once typing pauses. */
  markdown$: Observable<string>
  /**
   * Drop the edit waiting out its pause. For a caller about to serialize
   * itself (a save's flush) or to replace the document outright, either of
   * which would make that pending emission stale.
   */
  cancel(): void
  dispose(): void
}

/**
 * The model half of the two-way binding.
 *
 * Serializing walks the whole document, so it waits for a pause in typing.
 * `pending` is what lets `cancel()` reach an emission already scheduled: the
 * debounce still fires, finds nothing pending, and emits nothing — so a save
 * that flushes mid-pause cannot be followed by a stale second emission.
 */
export function createMarkdownSync(
  editor: Editor,
  options: { dueTime?: number; serialize?: (editor: Editor) => string } = {},
): MarkdownSync {
  const { dueTime = 200, serialize = (e: Editor) => docToMarkdown(e.state.doc, e.schema) } = options
  const out = new Subject<string>()
  let pending = false

  const subscription: Subscription = editorStreams(editor)
    .docChanged$.pipe(
      map(() => {
        pending = true
      }),
      debounceTime(dueTime),
      filter(() => pending && !editor.isDestroyed),
    )
    .subscribe(() => {
      pending = false
      out.next(serialize(editor))
    })

  return {
    markdown$: out.asObservable(),
    cancel: () => {
      pending = false
    },
    dispose: () => {
      subscription.unsubscribe()
      out.complete()
    },
  }
}
