// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { GlossaryTerm } from '@knowledge/contracts'
import { baseExtensions, parseMarkdown } from '@knowledge/editor-schema'
import { GlossaryTerms } from './glossary-terms'

// A column label names a field; it does not use the word (#703). The header
// cell stays plain while the same word in a body cell links.

const term = {
  termId: 't1',
  projectId: 'p1',
  term: 'Category',
  aliases: [],
  caseSensitive: false,
  matchAliases: true,
  enabled: true,
} as unknown as GlossaryTerm

let editor: Editor | null = null
afterEach(() => editor?.destroy())

function linked(markdown: string): string[] {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [...baseExtensions(), GlossaryTerms],
    content: parseMarkdown(markdown, document).toJSON(),
  })
  editor.commands.setGlossaryTerms([term])
  return [...editor.view.dom.querySelectorAll('a.kn-glossary')].map((a) => a.closest('th, td, h2')?.tagName ?? 'P')
}

describe('glossary terms', () => {
  it('skips a table header cell and links the body cell', () => {
    expect(linked('| Category |\n| --- |\n| a category |\n')).toEqual(['TD'])
  })

  it('still skips headings and links prose', () => {
    expect(linked('## Category\n\nPick a category.\n')).toEqual(['P'])
  })
})
