import { describe, expect, it } from 'vitest'
import { blockLineSpans, formatPageRef, markdownToHtml, parsePageRef } from '@knowledge/editor-schema/markdown'

const md = [
  '# Title', // 1
  '', // 2
  'A paragraph', // 3
  'over two lines.', // 4
  '', // 5
  '- one', // 6
  '- two', // 7
  '  - nested a', // 8
  '  - nested b', // 9
  '- three', // 10
  '', // 11
  '```ts', // 12
  'const a = 1', // 13
  '', // 14
  'const b = 2', // 15
  '```', // 16
  '', // 17
  '| a | b |', // 18
  '| - | - |', // 19
  '| 1 | 2 |', // 20
  '', // 21
  '<details>', // 22
  '<summary>More</summary>', // 23
  '', // 24
  'Hidden text.', // 25
  '', // 26
  '</details>', // 27
  '', // 28
  '> [!NOTE]', // 29
  '> A panel.', // 30
  '', // 31
  '1. loose', // 32
  '', // 33
  '   - inner', // 34
].join('\n')

describe('blockLineSpans (#708)', () => {
  const spans = blockLineSpans(md)
  const at = (type: string, start: number) => spans.find((s) => s.type === type && s.start === start)

  it('maps every block to its 1-based lines', () => {
    expect(at('heading', 1)).toMatchObject({ end: 1 })
    expect(at('paragraph', 3)).toMatchObject({ end: 4 })
    expect(at('list', 6)).toMatchObject({ end: 10 })
    expect(at('code', 12)).toMatchObject({ end: 16 })
    expect(at('table', 18)).toMatchObject({ end: 20 })
    expect(at('html', 22)).toMatchObject({ end: 27 })
    expect(at('paragraph', 25)).toMatchObject({ end: 25 })
    expect(at('blockquote', 29)).toMatchObject({ end: 30 })
  })

  it('gives list items, nested ones included, their own spans', () => {
    const items = spans.filter((s) => s.type === 'list_item').map((s) => [s.start, s.end])
    expect(items).toEqual([[6, 6], [7, 9], [8, 8], [9, 9], [10, 10], [32, 34], [34, 34]])
  })

  it('agrees with what each span slices out of the body', () => {
    const lines = md.split('\n')
    expect(lines.slice(at('code', 12)!.start - 1, at('code', 12)!.end).join('\n')).toBe('```ts\nconst a = 1\n\nconst b = 2\n```')
  })

  it('stamps the same spans as data-lines, offset by held-out lines', () => {
    const body = md.slice('# Title\n'.length)
    const html = markdownToHtml(body, { lineOffset: 1 })
    expect(html).toContain('<p data-lines="3-4">')
    expect(html).toContain('<li data-lines="7-9">')
    expect(html).toContain('<pre data-lines="12-16">')
    expect(html).toContain('<table data-lines="18-20">')
    expect(html).toContain('<details data-lines="22-27">')
    expect(markdownToHtml(body)).not.toContain('data-lines')
  })
})

describe('page refs (#708)', () => {
  it('round-trips the #L grammar and ignores heading anchors', () => {
    expect(parsePageRef('#L40-L52')).toEqual({ start: 40, end: 52 })
    expect(parsePageRef('#L7')).toEqual({ start: 7, end: 7 })
    expect(parsePageRef('#some-heading')).toBeNull()
    expect(parsePageRef('#L5-L3')).toBeNull()
    expect(formatPageRef({ start: 40, end: 52 })).toBe('L40-L52')
    expect(formatPageRef({ start: 7, end: 7 })).toBe('L7')
  })
})
