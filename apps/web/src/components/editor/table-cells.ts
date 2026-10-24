/**
 * Rows and columns of one table as a unit an action can target — what the
 * table handles delete or insert beside, independent of where the caret is.
 *
 * Deletion is written here against `removeRow` / `removeColumn` rather than by
 * selecting the band and running the stock `deleteRow()`: a cell selection
 * grows to cover any merged cell at its corners, so selecting "row 3" next to a
 * cell spanning rows 2–3 would delete row 2 as well.
 */
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import {
  TableMap,
  addColumn,
  addRow,
  isInTable,
  removeColumn,
  removeRow,
  selectedRect,
  type TableRect,
} from '@tiptap/pm/tables'

export type Axis = 'row' | 'column'

/** Rows (or columns) `from` up to, not including, `to` of the table whose content starts at `tableStart`. */
export interface Band {
  axis: Axis
  tableStart: number
  from: number
  to: number
}

/** The band the current selection covers: what `deleteRow()` / `deleteColumn()` would remove. */
export function selectionBand(state: EditorState, axis: Axis): Band | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  return axis === 'row'
    ? { axis, tableStart: rect.tableStart, from: rect.top, to: rect.bottom }
    : { axis, tableStart: rect.tableStart, from: rect.left, to: rect.right }
}

/** The band as a TableRect, or null once the table is gone or no longer has those rows/columns. */
function bandRect(doc: PMNode, band: Band): TableRect | null {
  // A peer's edit can shrink the doc under a stored position; `nodeAt` throws past its end.
  if (band.tableStart < 1 || band.tableStart > doc.content.size) return null
  const table = doc.nodeAt(band.tableStart - 1)
  if (table?.type.spec.tableRole !== 'table') return null
  const map = TableMap.get(table)
  const size = band.axis === 'row' ? map.height : map.width
  if (band.from < 0 || band.to > size || band.from >= band.to) return null
  const span =
    band.axis === 'row'
      ? { left: 0, right: map.width, top: band.from, bottom: band.to }
      : { left: band.from, right: band.to, top: 0, bottom: map.height }
  return { ...span, map, table, tableStart: band.tableStart }
}

/** The table node a band points into, or null once it no longer fits — compare two with `eq`. */
export function bandTable(doc: PMNode, band: Band): PMNode | null {
  return bandRect(doc, band)?.table ?? null
}

/** Content is any non-blank text or any leaf other than a line break — an image, a mention, an embed. */
function cellHasContent(cell: PMNode): boolean {
  let found = false
  cell.descendants((node) => {
    if (found) return false
    if (node.isText ? !!node.text?.trim() : node.isLeaf && node.type.name !== 'hardBreak') found = true
    return !found
  })
  return found
}

/**
 * How many cells holding content a delete of `band` would lose. A merged cell
 * counts once, and only if it lies wholly inside the band: one reaching past it
 * is shrunk by the delete, not removed, so its content survives.
 */
export function filledCellCount(doc: PMNode, band: Band): number {
  const rect = bandRect(doc, band)
  if (!rect) return 0
  let count = 0
  for (const pos of rect.map.cellsInRect(rect)) {
    const cell = rect.map.findCell(pos)
    const inside =
      band.axis === 'row'
        ? cell.top >= band.from && cell.bottom <= band.to
        : cell.left >= band.from && cell.right <= band.to
    if (inside && cellHasContent(rect.table.nodeAt(pos)!)) count++
  }
  return count
}

/** Whether `band` is every row (column) of its table — which the stock commands refuse to delete, too. */
export function isWholeTable(doc: PMNode, band: Band): boolean {
  const rect = bandRect(doc, band)
  if (!rect) return false
  return band.from === 0 && band.to === (band.axis === 'row' ? rect.map.height : rect.map.width)
}

/** Remove the band's rows (columns) in `tr`. False, and nothing done, when it no longer fits or is the whole table. */
export function deleteBand(tr: Transaction, band: Band): boolean {
  const rect = bandRect(tr.doc, band)
  if (!rect || isWholeTable(tr.doc, band)) return false
  // Bottom up, re-reading the table each time: every removal shifts the map.
  for (let i = band.to - 1; i >= band.from; i--) {
    if (band.axis === 'row') removeRow(tr, rect, i)
    else removeColumn(tr, rect, i)
    rect.table = tr.doc.nodeAt(band.tableStart - 1)!
    rect.map = TableMap.get(rect.table)
  }
  return true
}

/** Insert an empty row (column) before or after the band. */
export function insertBeside(tr: Transaction, band: Band, side: 'before' | 'after'): boolean {
  const rect = bandRect(tr.doc, band)
  if (!rect) return false
  const at = side === 'before' ? band.from : band.to
  if (band.axis === 'row') addRow(tr, rect, at)
  else addColumn(tr, rect, at)
  return true
}
