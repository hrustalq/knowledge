// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { editorSchema, parseMarkdown } from '@knowledge/editor-schema'
import { joinTitleHeading, splitTitleHeading } from '@knowledge/editor-schema/markdown'
import { docToMarkdown } from '@knowledge/editor-schema/serialize'

// #646: the editor holds a matching `# Title` out of the body and puts it back on write.
describe('title heading', () => {
  // The editor's own spelling: a page it has saved once round-trips exactly.
  const page = '# Event bus overview\n\nDomain events are published once.'
  const title = 'Event bus overview'

  it('loads without the title and saves untouched byte for byte', () => {
    const { heading, body } = splitTitleHeading(page, title)
    expect(body).toBe('Domain events are published once.')
    // load → editor → flush without edits
    const flushed = docToMarkdown(parseMarkdown(body, document), editorSchema, document)
    expect(joinTitleHeading(flushed, { heading, title }, title)).toBe(page)
  })

  it('keeps a first heading that is not the title in the body', () => {
    const other = '# Background\n\nText.\n'
    expect(splitTitleHeading(other, title)).toEqual({ heading: '', body: other })
    expect(joinTitleHeading(other, null, title)).toBe(other)
  })

  it('renames the heading with the page, and never adds a second one', () => {
    const { heading, body } = splitTitleHeading(page, title)
    expect(joinTitleHeading(body, { heading, title }, 'Event bus')).toBe('# Event bus\n\n' + body)
    // a draft seeded before the split still leads with the heading
    expect(joinTitleHeading(page, { heading, title }, title)).toBe(page)
  })
})
