<script setup lang="ts">
/**
 * A grip on the table's edge for one row (left border) and one column (top
 * border): the ones under the pointer, else the caret's. Its menu acts on that
 * row or column — not on wherever the caret happens to be — and a cell
 * selection that covers the hovered row widens it to the whole selection.
 *
 * Layout is read once per frame (frame$, pointer moves, scroll), never per
 * transaction. The grips are a fixed overlay outside ProseMirror's DOM, so the
 * commands are the only way anything here reaches the document.
 *
 * Keyboard: Tab inside a table moves between cells and never reaches the
 * grips, so Escape in a cell focuses the row grip, Tab moves on to the column
 * grip, and Escape on a grip returns to the caret.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { Editor } from '@tiptap/core'
import { CellSelection, TableMap, findTable, isInTable } from '@tiptap/pm/tables'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Subject, animationFrameScheduler, auditTime, fromEvent, merge } from 'rxjs'
import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  GripHorizontal,
  GripVertical,
  Trash2,
} from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { confirm } from '@/components/ui/confirm/use-confirm'
import { useSubscription } from '@/lib/rx-vue'
import { editorStreams } from './editor-streams'
import {
  bandTable,
  deleteBand,
  filledCellCount,
  insertBeside,
  isWholeTable,
  selectionBand,
  type Axis,
  type Band,
} from './table-cells'

const { t } = useI18n()
const props = defineProps<{ editor: Editor }>()

interface Span {
  start: number
  size: number
}
interface Layout {
  box: DOMRect
  /** What is actually visible: the wrapper's scrolled x-range, the surface's y-range. */
  clip: { top: number; bottom: number; left: number; right: number }
  rows: Span[]
  /** Null for a column that has no unmerged cell to measure. */
  cols: (Span | null)[]
}

const layout = shallowRef<Layout | null>(null)
const bands = shallowRef<Record<Axis, Band | null>>({ row: null, column: null })
/** A band held while its menu or its confirmation is open, so the pointer wandering off cannot retarget it. */
const held = ref<Axis | null>(null)
/** A grip under the pointer or focused: its band is highlighted. */
const emphasis = ref<Axis | null>(null)

/** The last pointer position over a table cell; null once the pointer leaves, or the keyboard takes over. */
let pointer: { x: number; y: number; table: HTMLTableElement } | null = null

const rootEl = ref<HTMLElement | null>(null)
// Queried, not template refs: reka's `as-child` slot replaces a ref on the button it wraps.
const grip = (axis: Axis) => rootEl.value?.querySelector<HTMLElement>(`.kn-table-grip-${axis === 'row' ? 'row' : 'col'}`)

function tableElementAt(pos: number): HTMLTableElement | null {
  const dom = props.editor.view.nodeDOM(pos)
  if (!(dom instanceof HTMLElement)) return null
  return dom instanceof HTMLTableElement ? dom : dom.querySelector('table')
}

function measure(tableEl: HTMLTableElement, tableStart: number): Layout | null {
  const { view, state } = props.editor
  const table = state.doc.nodeAt(tableStart - 1)
  if (!table) return null
  const map = TableMap.get(table)
  const rows = Array.from(tableEl.rows, (tr) => {
    const r = tr.getBoundingClientRect()
    return { start: r.top, size: r.height }
  })
  // The DOM has not caught up with the document yet; the next frame will.
  if (rows.length !== map.height) return null
  const cols = Array.from({ length: map.width }, (_, c) => {
    for (let r = 0; r < map.height; r++) {
      const pos = map.map[r * map.width + c]!
      const cell = map.findCell(pos)
      if (cell.left !== c || cell.right !== c + 1) continue
      const dom = view.nodeDOM(tableStart + pos)
      if (!(dom instanceof HTMLElement)) continue
      const b = dom.getBoundingClientRect()
      return { start: b.left, size: b.width }
    }
    return null
  })
  const wrap = (tableEl.closest('.tableWrapper') ?? tableEl).getBoundingClientRect()
  const surface = (view.dom.closest('.kn-editor-surface') ?? view.dom).getBoundingClientRect()
  return {
    box: tableEl.getBoundingClientRect(),
    clip: { top: surface.top, bottom: surface.bottom, left: wrap.left, right: wrap.right },
    rows,
    cols,
  }
}

/** The pointer's row/column, else the caret's band; a cell selection covering the pointer's row wins. */
function bandFor(axis: Axis, tableStart: number, index: number): Band | null {
  const caret = selectionBand(props.editor.state, axis)
  const here = caret?.tableStart === tableStart ? caret : null
  if (index < 0) return here
  if (here && props.editor.state.selection instanceof CellSelection && index >= here.from && index < here.to) return here
  return { axis, tableStart, from: index, to: index + 1 }
}

function update() {
  const { editor } = props
  if (editor.isDestroyed) return
  const { state, view } = editor
  let tableStart: number | null = null
  let tableEl: HTMLTableElement | null = null

  const heldBand = held.value ? bands.value[held.value] : null
  if (heldBand) {
    tableStart = heldBand.tableStart
    tableEl = bandTable(state.doc, heldBand) ? tableElementAt(tableStart - 1) : null
  } else if (pointer?.table.isConnected) {
    const cell = pointer.table.rows[0]?.cells[0]
    const found = cell ? findTable(state.doc.resolve(view.posAtDOM(cell, 0))) : null
    if (found) {
      tableStart = found.start
      tableEl = pointer.table
    }
  } else if (isInTable(state)) {
    const found = findTable(state.selection.$from)
    if (found) {
      tableStart = found.start
      tableEl = tableElementAt(found.pos)
    }
  }

  const next = tableEl && tableStart !== null ? measure(tableEl, tableStart) : null
  layout.value = next
  if (!next || tableStart === null) {
    if (!held.value) bands.value = { row: null, column: null }
    return
  }
  if (held.value) return
  const p = pointer
  const at = (spans: (Span | null)[], v: number | undefined) =>
    v === undefined ? -1 : spans.findIndex((s) => !!s && v >= s.start && v < s.start + s.size)
  bands.value = {
    row: bandFor('row', tableStart, at(next.rows, p?.y)),
    column: bandFor('column', tableStart, at(next.cols, p?.x)),
  }
}

const poke = new Subject<void>()
useSubscription(
  merge(
    editorStreams(props.editor).frame$,
    merge(poke, fromEvent(window, 'scroll', { capture: true, passive: true }), fromEvent(window, 'resize')).pipe(
      auditTime(0, animationFrameScheduler),
    ),
  ).subscribe(update),
)

function onPointerMove(event: PointerEvent) {
  const table = (event.target as Element | null)?.closest?.('td, th')?.closest('table')
  if (!table) return
  pointer = { x: event.clientX, y: event.clientY, table }
  poke.next()
}

/** Leaving the table for one of the grips keeps the target; leaving for anywhere else drops it. */
function onPointerLeave(event: PointerEvent) {
  const next = event.relatedTarget as Node | null
  if (next && (rootEl.value?.contains(next) || props.editor.view.dom.contains(next))) return
  pointer = null
  poke.next()
}

/**
 * A plugin, not a DOM listener: ProseMirror calls `preventDefault` on every
 * Escape, so a listener cannot tell "handled" from "not". Registered last, so
 * an open slash or mention menu still takes Escape first.
 */
const keys = new Plugin({
  key: new PluginKey('knTableHandles'),
  props: {
    handleKeyDown(_view, event) {
      // Typing means the caret, not the pointer, is what the grips should follow.
      pointer = null
      if (event.key !== 'Escape' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
      if (!isInTable(props.editor.state)) return false
      update()
      void nextTick(() => grip('row')?.focus())
      return true
    },
  },
})

onMounted(() => {
  const dom = props.editor.view.dom
  dom.addEventListener('pointermove', onPointerMove)
  dom.addEventListener('pointerleave', onPointerLeave)
  props.editor.registerPlugin(keys)
})
onBeforeUnmount(() => {
  const dom = props.editor.view.dom
  dom.removeEventListener('pointermove', onPointerMove)
  dom.removeEventListener('pointerleave', onPointerLeave)
  if (!props.editor.isDestroyed) props.editor.unregisterPlugin(keys.spec.key!)
})

/* ------------------------------------------------------------ geometry */

interface Placed {
  grip: { top: number; left: number }
  band: { top: number; left: number; width: number; height: number }
}

function placed(axis: Axis): Placed | null {
  const l = layout.value
  const b = bands.value[axis]
  if (!l || !b) return null
  const spans = axis === 'row' ? l.rows : l.cols
  const first = spans[b.from]
  const last = spans[b.to - 1]
  if (!first || !last) return null
  const start = first.start
  const end = last.start + last.size
  const left = Math.max(l.box.left, l.clip.left)
  const right = Math.min(l.box.right, l.clip.right)
  const top = Math.max(l.box.top, l.clip.top)
  const bottom = Math.min(l.box.bottom, l.clip.bottom)
  const mid = (start + end) / 2
  if (axis === 'row') {
    if (mid < l.clip.top || mid > l.clip.bottom) return null
    const y0 = Math.max(start, l.clip.top)
    return {
      grip: { top: mid, left },
      band: { top: y0, left, width: right - left, height: Math.min(end, l.clip.bottom) - y0 },
    }
  }
  if (mid < l.clip.left || mid > l.clip.right || l.box.top < l.clip.top || l.box.top > l.clip.bottom) return null
  const x0 = Math.max(start, l.clip.left)
  return {
    grip: { top: l.box.top, left: mid },
    band: { top, left: x0, width: Math.min(end, l.clip.right) - x0, height: bottom - top },
  }
}

const row = computed(() => placed('row'))
const column = computed(() => placed('column'))
const highlight = computed(() => {
  const axis = held.value ?? emphasis.value
  return axis ? placed(axis)?.band ?? null : null
})

const px = (box: Record<string, number>) => Object.fromEntries(Object.entries(box).map(([k, v]) => [k, `${v}px`]))

/** "3", or "2–4" for a band of several. */
function range(b: Band | null): string {
  if (!b) return ''
  return b.to - b.from === 1 ? String(b.from + 1) : `${b.from + 1}–${b.to}`
}
const size = (b: Band | null) => (b ? b.to - b.from : 0)
const wholeTable = (axis: Axis) => {
  const b = bands.value[axis]
  return !b || isWholeTable(props.editor.state.doc, b)
}

function deleteLabel(axis: Axis): string {
  const n = size(bands.value[axis])
  if (axis === 'row') return n > 1 ? t('toolbar.table.deleteRows', { count: n }, n) : t('toolbar.table.deleteRow')
  return n > 1 ? t('toolbar.table.deleteColumns', { count: n }, n) : t('toolbar.table.deleteColumn')
}

/* ------------------------------------------------------------- actions */

/**
 * The chosen action, run once the menu has closed: reka returns focus to the
 * grip on close, which would otherwise land after the action and take focus
 * back off the editor.
 */
let pending: (() => void) | null = null

function onOpen(axis: Axis, open: boolean) {
  if (open) held.value = axis
  else if (!pending && held.value === axis) held.value = null
}

function onCloseAutoFocus(event: Event) {
  const run = pending
  pending = null
  if (!run) return
  event.preventDefault()
  run()
}

function choose(axis: Axis, action: (band: Band) => void | Promise<void>) {
  const band = bands.value[axis]
  if (!band) return
  pending = () => {
    void Promise.resolve(action(band)).finally(() => {
      held.value = null
      pointer = null
      poke.next()
    })
  }
}

function insert(band: Band, side: 'before' | 'after') {
  props.editor.chain().focus().command(({ tr }) => insertBeside(tr, band, side)).run()
}

/**
 * Delete at once when every cell in the band is empty; otherwise ask first,
 * saying how many cells hold content. The band is stored before the dialog and
 * checked again after it, because in a shared draft another peer can change
 * the table while it is open — and deleting "row 3" of a different table is
 * worse than deleting nothing.
 */
async function remove(band: Band) {
  const { editor } = props
  const before = bandTable(editor.state.doc, band)
  const count = filledCellCount(editor.state.doc, band)
  if (count > 0) {
    // The dialog returns focus to whatever had it; make that the grip, not the body.
    grip(band.axis)?.focus()
    const n = size(band)
    const many = n > 1
    const title =
      band.axis === 'row'
        ? many ? t('toolbar.table.confirmDeleteRows', { count: n }, n) : t('toolbar.table.confirmDeleteRow')
        : many ? t('toolbar.table.confirmDeleteColumns', { count: n }, n) : t('toolbar.table.confirmDeleteColumn')
    const ok = await confirm({
      title,
      description: t('toolbar.table.confirmCellsLost', { count }, count),
      action: t('common.delete'),
      destructive: true,
    })
    if (!ok) return
    const after = bandTable(editor.state.doc, band)
    if (!before || !after?.eq(before)) {
      toast(t('toolbar.table.changedWhileConfirming'))
      return
    }
  }
  // After a dialog, focus goes back to the grip it was opened from.
  ;(count > 0 ? editor.chain() : editor.chain().focus()).command(({ tr }) => deleteBand(tr, band)).run()
}

function gripKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  props.editor.commands.focus()
}
</script>

<template>
  <div ref="rootEl" class="kn-table-handles" @pointerleave="onPointerLeave">
    <div v-if="highlight" class="kn-table-band" :style="px(highlight)" aria-hidden="true" />

    <DropdownMenu v-if="row" @update:open="onOpen('row', $event)">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="kn-table-grip kn-table-grip-row"
          :style="px(row.grip)"
          :aria-label="t('toolbar.table.rowHandle', { n: range(bands.row) })"
          :title="t('toolbar.table.rowHandle', { n: range(bands.row) })"
          @pointerenter="emphasis = 'row'"
          @pointerleave="emphasis = null"
          @focus="emphasis = 'row'"
          @blur="emphasis = null"
          @keydown="gripKeydown"
        >
          <GripVertical class="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="left" align="start" class="min-w-48" @close-auto-focus="onCloseAutoFocus">
        <DropdownMenuItem @select="choose('row', (b) => insert(b, 'before'))">
          <ArrowUpToLine /> {{ t('toolbar.table.insertRowAbove') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="choose('row', (b) => insert(b, 'after'))">
          <ArrowDownToLine /> {{ t('toolbar.table.insertRowBelow') }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" :disabled="wholeTable('row')" @select="choose('row', remove)">
          <Trash2 /> {{ deleteLabel('row') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    <DropdownMenu v-if="column" @update:open="onOpen('column', $event)">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          class="kn-table-grip kn-table-grip-col"
          :style="px(column.grip)"
          :aria-label="t('toolbar.table.columnHandle', { n: range(bands.column) })"
          :title="t('toolbar.table.columnHandle', { n: range(bands.column) })"
          @pointerenter="emphasis = 'column'"
          @pointerleave="emphasis = null"
          @focus="emphasis = 'column'"
          @blur="emphasis = null"
          @keydown="gripKeydown"
        >
          <GripHorizontal class="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" class="min-w-48" @close-auto-focus="onCloseAutoFocus">
        <DropdownMenuItem @select="choose('column', (b) => insert(b, 'before'))">
          <ArrowLeftToLine /> {{ t('toolbar.table.insertColumnLeft') }}
        </DropdownMenuItem>
        <DropdownMenuItem @select="choose('column', (b) => insert(b, 'after'))">
          <ArrowRightToLine /> {{ t('toolbar.table.insertColumnRight') }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" :disabled="wholeTable('column')" @select="choose('column', remove)">
          <Trash2 /> {{ deleteLabel('column') }}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>
