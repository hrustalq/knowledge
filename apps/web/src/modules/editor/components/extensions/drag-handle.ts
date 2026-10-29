/**
 * Block drag handle and inline insert button — the gutter affordance every
 * block editor has and Tiptap only ships in its paid tier. Implemented here on
 * plain ProseMirror so the editor stays MIT end to end.
 *
 * How it works: on pointer move we resolve the top-level block under the
 * cursor, park a floating handle at its left edge, and on drag hand ProseMirror
 * a slice for that node. ProseMirror then owns the drop, cursor and undo
 * behaviour, so reordering behaves exactly like a native selection drag.
 */
import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

export interface DragHandleEvents {
  /** Fired when the handle should move or hide. */
  onMove: (rect: { top: number; left: number; height: number } | null, pos: number | null) => void
  /**
   * Whether the pointer is currently on the handle itself. The handle sits in
   * the margin *outside* the editable area, so travelling to it necessarily
   * leaves ProseMirror — without this the handle hides the moment you reach
   * for it, which is exactly the bug that makes gutter handles feel broken.
   */
  isPointerOnHandle: () => boolean
}

/** Blocks that own their own internal layout; the handle targets them as a whole. */
const HANDLE_INSET = 8

function blockPosAt(view: EditorView, x: number, y: number): number | null {
  const coords = view.posAtCoords({ left: x, top: y })
  if (!coords) return null
  const $pos = view.state.doc.resolve(coords.pos)
  // depth 1 is a direct child of the doc — the unit a reader thinks of as "a block".
  if ($pos.depth === 0) {
    const after = $pos.nodeAfter
    return after ? coords.pos : null
  }
  return $pos.before(1)
}

export function createDragHandle(events: DragHandleEvents) {
  const key = new PluginKey('knDragHandle')

  return Extension.create({
    name: 'knDragHandle',

    addProseMirrorPlugins() {
      let hovered: number | null = null

      const hide = () => {
        if (events.isPointerOnHandle()) return
        hovered = null
        events.onMove(null, null)
      }

      return [
        new Plugin({
          key,
          props: {
            handleDOMEvents: {
              mousemove: (view, event) => {
                if (!view.editable) return false
                const pos = blockPosAt(view, event.clientX, event.clientY)
                if (pos === null) {
                  // Gaps between blocks and the gutter margin both land here.
                  // Keeping the last target beats flickering the handle away.
                  return false
                }
                if (pos === hovered) return false
                hovered = pos
                const dom = view.nodeDOM(pos)
                const el = dom instanceof HTMLElement ? dom : (dom as Text | null)?.parentElement
                if (!el) {
                  hide()
                  return false
                }
                const rect = el.getBoundingClientRect()
                events.onMove({ top: rect.top, left: rect.left - HANDLE_INSET, height: rect.height }, pos)
                return false
              },
            },
          },
        }),
      ]
    },
  })
}

/**
 * Select the block at `pos` and let ProseMirror take over the drag. Called from
 * the handle's dragstart so the browser's drag image and the editor's drop
 * target come from the same source of truth.
 */
export function startBlockDrag(view: EditorView, pos: number, event: DragEvent): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  const selection = NodeSelection.create(view.state.doc, pos)
  view.dispatch(view.state.tr.setSelection(selection))

  const slice = selection.content()
  const { dom, text } = view.serializeForClipboard
    ? view.serializeForClipboard(slice)
    : { dom: document.createElement('div'), text: '' }

  event.dataTransfer?.clearData()
  event.dataTransfer?.setData('text/html', (dom as HTMLElement).innerHTML)
  event.dataTransfer?.setData('text/plain', text)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'

  const nodeDom = view.nodeDOM(pos)
  if (nodeDom instanceof HTMLElement && event.dataTransfer) {
    event.dataTransfer.setDragImage(nodeDom, 0, 0)
  }

  view.dragging = { slice, move: true }
}

/** Delete the block at `pos`. */
export function deleteBlock(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize))
  view.focus()
}

/** Copy the block at `pos` directly beneath itself. */
export function duplicateBlock(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  const end = pos + node.nodeSize
  view.dispatch(view.state.tr.insert(end, node.copy(node.content)))
  view.focus()
}

/** Select the block at `pos` without starting a drag — used before a menu action. */
export function selectBlock(view: EditorView, pos: number): void {
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
}
