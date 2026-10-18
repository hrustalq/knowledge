// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { prosemirrorToYDoc, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { BODY_FIELD, editorSchema, parseMarkdown } from '@knowledge/editor-schema'
import { docToMarkdown } from './editor-streams'

// A shared draft (#80) holds the page as a Y.Doc between seed and publish. It
// must change nothing: every custom node through `md → PM → Y → wire → PM → md`
// has to come out as today's `md → PM → md` (docs/features/56, §5).
const FIXTURES: Record<string, string> = {
  basics:
    '# Title\n\nPara with **bold**, _em_, `code`, ==hi== and a [link](https://x.test).\n\n- a\n  - b\n\n1. one\n2. two\n\n---\n\n> quote\n',
  code: '```ts\nconst a = 1\n```\n',
  tasks: '- [x] done\n- [ ] todo\n',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  panel: '> [!warning]\n> Careful **here**.\n',
  expand: '<details open>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n',
  layout: '<div data-kn-layout="2">\n<div data-kn-col>\n\nLeft\n\n</div>\n<div data-kn-col>\n\nRight\n\n</div>\n</div>\n',
  toc: '<div data-kn-toc="1"></div>\n\n## H2\n',
  api: '<div data-kn-api="POST" data-kn-path="/invoices/{id}" data-kn-op="op:billing:post-/invoices">\n\n### POST /invoices/{id}\n\n<div data-kn-api-section="summary">\n\nBills a customer.\n\n</div>\n\n</div>\n',
  mermaid: '```mermaid\ngraph TD; A-->B\n```\n',
  drawing:
    '```drawing\n{"type":"excalidraw","version":2,"elements":[{"id":"r1","type":"rectangle","x":1,"y":2}],"appState":{}}\n```\n',
  file: '<div data-kn-file="f1" data-kn-name="spec.pdf" data-kn-mime="application/pdf" data-kn-size="2048"><a href="/v1/attachments/f1">spec.pdf</a></div>\n',
  image: '<img src="/v1/attachments/i1" alt="diagram" width="320" />\n\n![plain](/v1/attachments/i2)\n',
  status: 'State: <span data-kn-status="green">DONE</span>\n',
  mentions:
    'Ask <span data-kn-user="00000000-0000-4000-8000-000000000001">@Ada</span> and <span data-kn-agent="reviewer">@Reviewer</span>, see <span data-kn-doc="00000000-0000-4000-8000-000000000002">@Billing</span>.\n',
}

const toDoc = (md: string) => parseMarkdown(md, document)
const md = (doc: PMNode) => docToMarkdown(doc, editorSchema)

/** Into a Y.Doc, over the wire as a peer receives it, and back out. */
function viaY(doc: PMNode): PMNode {
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(prosemirrorToYDoc(doc, BODY_FIELD)))
  return yXmlFragmentToProseMirrorRootNode(peer.getXmlFragment(BODY_FIELD), editorSchema)
}

/** Y.XmlElement attributes hold JSON only; anything else is lost on the way. */
function nonJsonAttrs(doc: PMNode): string[] {
  const bad: string[] = []
  doc.descendants((node) => {
    for (const [key, value] of Object.entries(node.attrs)) {
      if (typeof value === 'function' || (value !== null && typeof value === 'object' && JSON.stringify(value) === undefined)) {
        bad.push(`${node.type.name}.${key}`)
      }
    }
  })
  return bad
}

/** The first text inside a block, to type into as a peer would. */
function firstText(el: Y.XmlElement | Y.XmlFragment): Y.XmlText | undefined {
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) return child
    const found = firstText(child as Y.XmlElement)
    if (found) return found
  }
  return undefined
}

describe('markdown through a shared draft', () => {
  for (const [name, source] of Object.entries(FIXTURES)) {
    it(`${name}: survives the Y.Doc unchanged`, () => {
      const doc = toDoc(source)
      expect(nonJsonAttrs(doc)).toEqual([])
      const back = viaY(doc)
      expect(back.eq(doc)).toBe(true)
      expect(md(back)).toBe(md(doc))
    })
  }

  it('concurrent edits in one table cell and a panel merge into markdown that re-parses to itself', () => {
    const a = prosemirrorToYDoc(toDoc(`${FIXTURES.table}\n${FIXTURES.panel}`), BODY_FIELD)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const blocks = (doc: Y.Doc) => doc.getXmlFragment(BODY_FIELD)
    firstText(blocks(a).get(0) as Y.XmlElement)!.insert(0, 'A-')
    firstText(blocks(b).get(0) as Y.XmlElement)!.insert(0, 'B-')
    firstText(blocks(b).get(1) as Y.XmlElement)!.insert(0, 'B2-')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    const merged = md(yXmlFragmentToProseMirrorRootNode(blocks(a), editorSchema))
    expect(merged).toBe(md(yXmlFragmentToProseMirrorRootNode(blocks(b), editorSchema)))
    expect(merged).toContain('B2-')
    expect(merged).toMatch(/A-B-|B-A-/)
    expect(md(toDoc(merged))).toBe(merged)
  })

  it('two peers typing into one list item keep both edits', () => {
    const a = prosemirrorToYDoc(toDoc('- first\n- second\n'), BODY_FIELD)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const text = (doc: Y.Doc) => firstText(doc.getXmlFragment(BODY_FIELD))!
    text(a).insert(5, ' (A)')
    text(b).insert(0, 'B: ')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const merged = md(yXmlFragmentToProseMirrorRootNode(a.getXmlFragment(BODY_FIELD), editorSchema))
    expect(merged).toContain('B: first (A)')
    expect(md(toDoc(merged))).toBe(merged)
  })
})
