import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * What an API block section actually says: everything but its label and its
 * tables' header rows. The template inserts both, so a section the author
 * never filled in still has text — and must still read as empty.
 */
export function writtenText(section: PMNode): string {
  let text = ''
  section.forEach((child) => {
    if (child.type.name === 'heading') return
    if (child.type.name === 'table') {
      child.forEach((row) => row.forEach((cell) => {
        if (cell.type.name !== 'tableHeader') text += cell.textContent
      }))
      return
    }
    text += child.textContent
  })
  return text.trim()
}

/** The rows an author filled in across a section's tables — its count chip. */
export function writtenRows(section: PMNode): number {
  let rows = 0
  section.forEach((child) => {
    if (child.type.name !== 'table') return
    child.forEach((row) => {
      let text = ''
      row.forEach((cell) => {
        if (cell.type.name !== 'tableHeader') text += cell.textContent
      })
      if (text.trim()) rows += 1
    })
  })
  return rows
}

/** The section's own label: its heading, as the author (or the template) wrote it. */
export function sectionLabel(section: PMNode): string {
  let label = ''
  section.forEach((child) => {
    if (!label && child.type.name === 'heading') label = child.textContent.trim()
  })
  return label
}

/** A section's first table as text: header cells and body rows — what the read view draws from. */
export function sectionTable(section: PMNode): { headers: string[]; rows: string[][] } | null {
  let table: PMNode | null = null
  section.forEach((child) => {
    if (!table && child.type.name === 'table') table = child
  })
  if (!table) return null
  const headers: string[] = []
  const rows: string[][] = []
  ;(table as PMNode).forEach((row) => {
    const cells: string[] = []
    let header = true
    row.forEach((cell) => {
      if (cell.type.name !== 'tableHeader') header = false
      cells.push(cell.textContent)
    })
    if (header && headers.length === 0) headers.push(...cells)
    else rows.push(cells)
  })
  return { headers, rows }
}
