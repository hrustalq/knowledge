// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { baseExtensions } from '@knowledge/editor-schema'
import { Embed } from './media'

// The paste rule (#470): a Figma link alone on an empty line becomes a
// one-item group; inside a sentence, or not Figma, the paste is left alone.
const KEY = 'AbCdEfGhIj12'
let editor: Editor | null = null
afterEach(() => editor?.destroy())

function paste(content: string, text: string, onPasted = vi.fn()) {
  editor = new Editor({ extensions: [...baseExtensions(), Embed.configure({ onEdit: null, onPasted })], content })
  editor.commands.focus('end')
  const event = { clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') } } as unknown as ClipboardEvent
  const handled = editor.view.someProp('handlePaste', (f) => f(editor!.view, event, Slice.empty)) ?? false
  return { handled, json: editor.getJSON(), onPasted }
}

describe('pasting a Figma link', () => {
  it('on an empty line becomes a group, canonical and unpinned, and asks to pin it', () => {
    const { handled, json, onPasted } = paste('<p>Intro</p><p></p>', `https://www.figma.com/design/${KEY}/App?node-id=12-34&t=abc`)
    expect(handled).toBe(true)
    const url = `https://www.figma.com/design/${KEY}/?node-id=12-34`
    expect(json.content?.[1]).toEqual({ type: 'knEmbed', attrs: { layout: 'strip', caption: '', items: [{ url, version: null, caption: '' }] } })
    expect(onPasted).toHaveBeenCalledWith(url)
  })

  it('inside a sentence stays a link', () => {
    expect(paste('<p>See </p>', `https://www.figma.com/design/${KEY}/`).handled).toBe(false)
  })

  it('that is not Figma, or carries other text, is not touched', () => {
    expect(paste('<p></p>', 'https://example.com/x').handled).toBe(false)
    expect(paste('<p></p>', `see https://www.figma.com/design/${KEY}/`).handled).toBe(false)
  })
})
