// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import DOMPurify from 'dompurify'
import { canonicalEmbedUrl, parseEmbedUrl } from '@knowledge/contracts/embeds'
import { editorSchema, parseMarkdown } from '@knowledge/editor-schema'
import { docToMarkdown } from '@knowledge/editor-schema/serialize'
import { SANITIZE_CONFIG, markdownToHtml } from './render'

// The embed block (#470, docs/features/64): one URL matcher, and markdown that
// carries captioned links and pinned versions, never an image.
const KEY = 'AbCdEfGhIj12'

describe('parseEmbedUrl', () => {
  it.each([
    [`https://www.figma.com/design/${KEY}/Checkout?node-id=12-34&t=x`, { fileKey: KEY, nodeId: '12:34', board: false }],
    [`https://figma.com/file/${KEY}/Old`, { fileKey: KEY, nodeId: null, board: false }],
    [`https://www.figma.com/proto/${KEY}/P?node-id=1-2&starting-point-node-id=1%3A2`, { fileKey: KEY, nodeId: '1:2', board: false }],
    [`https://www.figma.com/design/${KEY}/X?node-id=5-6&m=dev`, { fileKey: KEY, nodeId: '5:6', board: false }],
    [`https://www.figma.com/design/${KEY}/branch/BrAnChKeY99/X`, { fileKey: 'BrAnChKeY99', nodeId: null, board: false }],
    [`https://www.figma.com/board/${KEY}/Flow`, { fileKey: KEY, nodeId: null, board: true }],
    [`https://www.figma.com/design/${KEY}/X?node-id=I1-2%3B3-4`, { fileKey: KEY, nodeId: 'I1:2;3:4', board: false }],
  ])('%s', (url, ref) => {
    expect(parseEmbedUrl(url)).toEqual({ provider: 'figma', ...ref })
  })

  it.each([
    'http://www.figma.com/design/AbCdEfGhIj12/',
    'https://evil.figma.com.example/design/AbCdEfGhIj12/',
    'https://www.figma.com/community/file/123',
    'https://www.figma.com/design/short/',
    'not a url',
  ])('refuses %s', (url) => expect(parseEmbedUrl(url)).toBeNull())

  it('canonicalizes two links to one node to the same string', () => {
    const a = parseEmbedUrl(`https://www.figma.com/design/${KEY}/A?node-id=12-34&t=1`)!
    const b = parseEmbedUrl(`https://figma.com/proto/${KEY}/B?node-id=12-34`)!
    expect(canonicalEmbedUrl(a)).toBe(`https://www.figma.com/design/${KEY}/?node-id=12-34`)
    expect(canonicalEmbedUrl(b)).toBe(canonicalEmbedUrl(a))
  })
})

describe('the embed block in markdown', () => {
  const md = (source: string) => docToMarkdown(parseMarkdown(source, document), editorSchema, document)

  it('canonicalizes item URLs and keeps versions, captions and layout', () => {
    const out = md(
      `<figure data-kn-embed="grid">\n<a href="https://figma.com/file/${KEY}/Old?node-id=12-34" data-kn-version="7">Sign-in</a>\n<figcaption>Flow</figcaption>\n</figure>`,
    )
    expect(out).toBe(
      `<figure data-kn-embed="grid">\n<a href="https://www.figma.com/design/${KEY}/?node-id=12-34" data-kn-version="7">Sign-in</a>\n<figcaption>Flow</figcaption>\n</figure>`,
    )
  })

  it('keeps an item no provider claims and an unpinned one, as written', () => {
    const source = `<figure data-kn-embed="strip">\n<a href="https://example.com/x">Other</a>\n<a href="https://www.figma.com/design/${KEY}/">https://www.figma.com/design/${KEY}/</a>\n</figure>`
    expect(md(source)).toBe(source)
  })

  it('reads a group split by blank lines, and writes it back as one HTML block', () => {
    const out = md(`<figure data-kn-embed>\n\n<a href="https://www.figma.com/board/${KEY}/" data-kn-version="1">Board</a>\n\n</figure>`)
    expect(out).toBe(`<figure data-kn-embed="strip">\n<a href="https://www.figma.com/board/${KEY}/" data-kn-version="1">Board</a>\n</figure>`)
    expect(out).not.toMatch(/\n\n/)
  })

  it('escapes captions', () => {
    const doc = editorSchema.node('doc', null, [
      editorSchema.node('knEmbed', { items: [{ url: 'https://example.com/', version: null, caption: '<b>"x"</b>' }], caption: 'a & b' }),
    ])
    const out = docToMarkdown(doc, editorSchema, document)
    expect(out).toContain('>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</a>')
    expect(out).toContain('<figcaption>a &amp; b</figcaption>')
  })

  it('survives the read view sanitizer', () => {
    const html = DOMPurify.sanitize(
      markdownToHtml(`<figure data-kn-embed="grid">\n<a href="https://www.figma.com/design/${KEY}/" data-kn-version="7">A</a>\n<figcaption>C</figcaption>\n</figure>`),
      { ...SANITIZE_CONFIG },
    )
    expect(html).toContain('<figure data-kn-embed="grid">')
    expect(html).toContain('data-kn-version="7"')
    expect(html).toContain('<figcaption>C</figcaption>')
  })
})
