// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { parseMarkdown } from '@knowledge/editor-schema'
import { anchorFromRange, blockRangeAt, resolveAnchorInDoc } from './comment-anchors'

// A margin comment on one list item or one table row (#439): the anchor is
// read off the document projection, so it must resolve back to that block's
// text — DOM text glued "Cell1Cell2" and never matched.

const PAGE = `Intro paragraph.

- First item
- Second item
  - Nested item

| Name | Owner |
| ---- | ----- |
| Billing | Ada |
| Search | Bo |
`

/** Position of the first character of `text` in the document. */
function posOf(doc: PMNode, text: string): number {
  let at = -1
  doc.descendants((node, pos) => {
    if (at >= 0) return false
    const i = node.isText ? (node.text ?? '').indexOf(text) : -1
    if (i >= 0) at = pos + i
    return true
  })
  if (at < 0) throw new Error(`not in doc: ${text}`)
  return at
}

function roundTrip(doc: PMNode, inside: string) {
  const range = blockRangeAt(doc, posOf(doc, inside))!
  const anchor = anchorFromRange(doc, range.from, range.to)!
  const resolved = resolveAnchorInDoc(doc, { type: 'text', revisionId: 'r', ...anchor })!
  return { quote: anchor.quote, text: doc.textBetween(resolved.from, resolved.to, ' ') }
}

describe('block anchors (#439)', () => {
  const doc = parseMarkdown(PAGE, document)

  it('a list item quotes its own text, not its nested items', () => {
    expect(roundTrip(doc, 'Second item')).toEqual({ quote: 'Second item', text: 'Second item' })
    expect(roundTrip(doc, 'Nested item')).toEqual({ quote: 'Nested item', text: 'Nested item' })
  })

  it('a table row quotes its cells with the projection spacing', () => {
    expect(roundTrip(doc, 'Billing')).toEqual({ quote: 'Billing Ada', text: 'Billing Ada' })
  })

  it('a paragraph quotes the whole block', () => {
    expect(roundTrip(doc, 'Intro')).toEqual({ quote: 'Intro paragraph.', text: 'Intro paragraph.' })
  })
})
