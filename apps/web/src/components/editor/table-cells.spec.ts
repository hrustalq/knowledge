import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { editorSchema } from '@knowledge/editor-schema'
import { deleteBand, filledCellCount, isWholeTable, selectionBand, type Band } from './table-cells'

const { nodes } = editorSchema

type Spec = string | { text?: string; colspan?: number; rowspan?: number; atom?: boolean }

function cell(spec: Spec, header = false): PMNode {
  const s = typeof spec === 'string' ? { text: spec } : spec
  const inline = s.atom
    ? [nodes.knUserMention.create({ userId: '00000000-0000-4000-8000-000000000001', label: 'Ada' })]
    : s.text
      ? [editorSchema.text(s.text)]
      : []
  const type = header ? nodes.tableHeader : nodes.tableCell
  return type.create({ colspan: s.colspan ?? 1, rowspan: s.rowspan ?? 1 }, nodes.paragraph.create(null, inline))
}

/** A doc holding one table; the first row is a header row when `header`. */
function doc(rows: Spec[][], header = false): PMNode {
  const table = nodes.table.create(
    null,
    rows.map((row, i) => nodes.tableRow.create(null, row.map((c) => cell(c, header && i === 0)))),
  )
  return nodes.doc.create(null, [table])
}

// The table node sits at 0, so its content starts at 1.
const rows = (from: number, to = from + 1): Band => ({ axis: 'row', tableStart: 1, from, to })
const cols = (from: number, to = from + 1): Band => ({ axis: 'column', tableStart: 1, from, to })

describe('filledCellCount', () => {
  const grid = doc(
    [
      ['A', 'B', 'C'],
      ['', '  ', ''],
      ['x', '', { atom: true }],
    ],
    true,
  )

  it('is zero for an empty row and for whitespace-only cells', () => {
    expect(filledCellCount(grid, rows(1))).toBe(0)
  })

  it('counts text and inline atoms, header cells included', () => {
    expect(filledCellCount(grid, rows(0))).toBe(3)
    expect(filledCellCount(grid, rows(2))).toBe(2)
    expect(filledCellCount(grid, cols(2))).toBe(2)
    expect(filledCellCount(grid, cols(1))).toBe(1)
  })

  it('covers every row of a multi-row band', () => {
    expect(filledCellCount(grid, rows(0, 3))).toBe(5)
    expect(filledCellCount(grid, rows(1, 3))).toBe(2)
  })

  it('counts a merged cell once, and only when the band holds all of it', () => {
    const merged = doc([
      [{ text: 'tall', rowspan: 2 }, 'b'],
      ['c'],
      [{ text: 'wide', colspan: 2 }],
    ])
    // Row 1 alone: the tall cell reaches into row 0 and survives the delete.
    expect(filledCellCount(merged, rows(1))).toBe(1)
    expect(filledCellCount(merged, rows(0, 2))).toBe(3)
    // Column 0 alone: the wide cell is shrunk, not removed.
    expect(filledCellCount(merged, cols(0))).toBe(1)
    expect(filledCellCount(merged, cols(0, 2))).toBe(4)
  })

  it('is zero for a band that no longer fits the table', () => {
    expect(filledCellCount(grid, rows(3))).toBe(0)
    expect(filledCellCount(grid, { ...rows(0), tableStart: 999 })).toBe(0)
  })
})

describe('selectionBand', () => {
  it('spans a multi-row cell selection', () => {
    const d = doc([['a', 'b'], ['c', 'd'], ['e', 'f']])
    const state = EditorState.create({ doc: d, schema: editorSchema })
    // Cell positions: the first cell of row 0 is at 1 + 1 (table start, row open).
    const first = d.resolve(2)
    const lastRow = d.child(0).child(1)
    const headCell = 1 + d.child(0).child(0).nodeSize + 1 + lastRow.child(0).nodeSize
    const selected = state.apply(state.tr.setSelection(CellSelection.create(d, first.pos, headCell)))
    expect(selectionBand(selected, 'row')).toEqual(rows(0, 2))
    expect(selectionBand(selected, 'column')).toEqual(cols(0, 2))
  })
})

describe('deleteBand', () => {
  it('removes exactly the band, beside a merged cell', () => {
    const d = doc([
      [{ text: 'tall', rowspan: 2 }, 'b'],
      ['c'],
      ['e', 'f'],
    ])
    const state = EditorState.create({ doc: d, schema: editorSchema })
    const tr = state.tr
    expect(deleteBand(tr, rows(1))).toBe(true)
    const table = tr.doc.child(0)
    expect(table.childCount).toBe(2)
    expect(table.textContent).toBe('tallbef')
  })

  it('refuses the whole table, as the stock commands do', () => {
    const d = doc([['a', 'b']])
    expect(isWholeTable(d, rows(0))).toBe(true)
    expect(deleteBand(EditorState.create({ doc: d, schema: editorSchema }).tr, rows(0))).toBe(false)
  })
})
