// @vitest-environment jsdom
// SPIKE (#80 phase 0) — throwaway. Does every custom node survive the Y.Doc,
// and do the editor's real extensions build a schema headless (seeding A)?
import { describe, expect, it, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
const log = (...a: unknown[]) => appendFileSync('/private/tmp/claude-501/-Users-hrustalq-Projects-knowledge/83d871d3-0910-4960-9529-2a6673903065/scratchpad/rt-out.log', a.map(String).join(' ') + '\n')
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import { generateJSON } from '@tiptap/html'
import { Node as PMNode } from '@tiptap/pm/model'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import { createLowlight, common } from 'lowlight'
import { markdownToHtml } from '@/lib/markdown/render'
import { docToMarkdown } from './editor-streams'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))

const { Panel, Expand, Layout, LayoutColumn, TableOfContents } = await import('./extensions/blocks')
const { ApiContract, ApiSection } = await import('./extensions/api')
const { Mermaid, Drawing, FileEmbed, ResizableImage } = await import('./extensions/media')
const { StatusMark, DocMention, UserMention, AgentMention } = await import('./extensions/inline')
const { AiSuggestions } = await import('./extensions/ai-suggestions')
const { CommentAnchors } = await import('./extensions/comment-anchors')

const t = (k: string) => k
const extensions = [
  StarterKit.configure({ codeBlock: false, undoRedo: false, heading: { levels: [1, 2, 3, 4] } }),
  CodeBlockLowlight.configure({ lowlight: createLowlight(common), defaultLanguage: null }),
  TaskList, TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: true, lastColumnResizable: false } }),
  Highlight, TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Panel, Expand, Layout, LayoutColumn, TableOfContents,
  ApiContract.configure({ t }), ApiSection,
  Mermaid, Drawing, FileEmbed, ResizableImage.configure({ inline: false, allowBase64: false }),
  StatusMark, DocMention, UserMention, AgentMention,
  CommentAnchors.configure({ t }), AiSuggestions.configure({ t }),
]
const schema = getSchema(extensions)

const FIXTURES: Record<string, string> = {
  basics: '# Title\n\nPara with **bold**, _em_, `code`, ==hi== and a [link](https://x.test).\n\n- a\n  - b\n\n1. one\n2. two\n\n---\n\n> quote\n',
  code: '```ts\nconst a = 1\n```\n',
  tasks: '- [x] done\n- [ ] todo\n',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
  panel: '> [!warning]\n> Careful **here**.\n',
  expand: '<details open>\n<summary>More</summary>\n\nHidden body.\n\n</details>\n',
  layout: '<div data-kn-layout="2">\n<div data-kn-col>\n\nLeft\n\n</div>\n<div data-kn-col>\n\nRight\n\n</div>\n</div>\n',
  toc: '<div data-kn-toc="1"></div>\n\n## H2\n',
  api: '<div data-kn-api="POST" data-kn-path="/invoices/{id}" data-kn-op="op:billing:post-/invoices">\n\n### POST /invoices/{id}\n\n<div data-kn-api-section="summary">\n\nBills a customer.\n\n</div>\n\n</div>\n',
  mermaid: '```mermaid\ngraph TD; A-->B\n```\n',
  drawing: '```drawing\n{"type":"excalidraw","version":2,"elements":[{"id":"r1","type":"rectangle","x":1,"y":2}],"appState":{}}\n```\n',
  file: '<div data-kn-file="f1" data-kn-name="spec.pdf" data-kn-mime="application/pdf" data-kn-size="2048"><a href="/v1/attachments/f1">spec.pdf</a></div>\n',
  image: '<img src="/v1/attachments/i1" alt="diagram" width="320" />\n\n![plain](/v1/attachments/i2)\n',
  status: 'State: <span data-kn-status="green">DONE</span>\n',
  mentions: 'Ask <span data-kn-user="00000000-0000-4000-8000-000000000001">@Ada</span> and <span data-kn-agent="reviewer">@Reviewer</span> about [[Some page]].\n',
  align: '<p style="text-align: center">Centered</p>\n',
}

const toDoc = (md: string) => PMNode.fromJSON(schema, generateJSON(markdownToHtml(md), extensions))
const viaY = (doc: PMNode) => {
  const ydoc = new Y.Doc()
  const frag = ydoc.getXmlFragment('body')
  prosemirrorJSONToYXmlFragment(schema, doc.toJSON(), frag)
  // Through the wire, as a peer would get it.
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc))
  return yXmlFragmentToProseMirrorRootNode(peer.getXmlFragment('body'), schema)
}
const md = (doc: PMNode) => docToMarkdown(doc, schema)

/** Every attr must survive Y.XmlElement attributes, which only hold JSON. */
function nonJsonAttrs(doc: PMNode): string[] {
  const bad: string[] = []
  doc.descendants((n) => {
    for (const [k, v] of Object.entries(n.attrs)) {
      if (v !== null && typeof v === 'object' && JSON.stringify(v) === undefined) bad.push(`${n.type.name}.${k}`)
      if (typeof v === 'function') bad.push(`${n.type.name}.${k}`)
    }
  })
  return bad
}

describe('spike: markdown ↔ Y.Doc round-trip', () => {
  it('lists the schema the headless extensions build', () => {
    log('nodes:', Object.keys(schema.nodes).join(' '))
    log('marks:', Object.keys(schema.marks).join(' '))
  })

  for (const [name, source] of Object.entries(FIXTURES)) {
    it(`${name}: md→PM→Y→PM→md equals md→PM→md`, () => {
      const doc = toDoc(source)
      const baseline = md(doc)
      const types = new Set<string>()
      doc.descendants((n) => { types.add(n.type.name); n.marks.forEach((m) => types.add('@' + m.type.name)) })
      log(`[${name}]`, [...types].join(','), '| attrs:', JSON.stringify(doc.firstChild?.attrs))
      if (source.trim() !== baseline.trim()) log(`[${name}] today normalizes:`, JSON.stringify(baseline.trim()).slice(0, 160))
      expect(nonJsonAttrs(doc)).toEqual([])
      expect(md(viaY(doc))).toBe(baseline)
      expect(viaY(doc).eq(doc)).toBe(true)
    })
  }

  it('concurrency: two peers edit one table cell and one panel, merge, still valid markdown', () => {
    const base = toDoc(FIXTURES.table + '\n' + FIXTURES.panel)
    const a = new Y.Doc(), b = new Y.Doc()
    prosemirrorJSONToYXmlFragment(schema, base.toJSON(), a.getXmlFragment('body'))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // Find the first Y.XmlText under each top-level block and type into it.
    const firstText = (el: Y.XmlElement | Y.XmlFragment): Y.XmlText => {
      for (const c of el.toArray()) {
        if (c instanceof Y.XmlText) return c
        const found = firstText(c as Y.XmlElement)
        if (found) return found
      }
      return undefined as unknown as Y.XmlText
    }
    firstText(a.getXmlFragment('body').get(0) as Y.XmlElement).insert(0, 'A-')
    firstText(b.getXmlFragment('body').get(0) as Y.XmlElement).insert(0, 'B-')
    firstText(b.getXmlFragment('body').get(1) as Y.XmlElement).insert(0, 'B2-')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const merged = md(yXmlFragmentToProseMirrorRootNode(a.getXmlFragment('body'), schema))
    expect(merged).toBe(md(yXmlFragmentToProseMirrorRootNode(b.getXmlFragment('body'), schema)))
    // Re-parse the merged markdown: it must round-trip as today's normalization.
    expect(md(toDoc(merged))).toBe(merged)
    log(merged)
  })

  it('size: Y state of a typical page vs its markdown', () => {
    const source = Object.values(FIXTURES).join('\n')
    const ydoc = new Y.Doc()
    prosemirrorJSONToYXmlFragment(schema, toDoc(source).toJSON(), ydoc.getXmlFragment('body'))
    log(`markdown ${source.length} B → Y state ${Y.encodeStateAsUpdate(ydoc).byteLength} B`)
    const big = Array.from({ length: 20 }, () => source).join('\n')
    for (const [label, text] of [['fixture page', source], ['20× fixture page', big]] as const) {
      const t0 = performance.now()
      const N = 20
      for (let i = 0; i < N; i++) {
        const d = new Y.Doc()
        prosemirrorJSONToYXmlFragment(schema, generateJSON(markdownToHtml(text), extensions), d.getXmlFragment('body'))
        Y.encodeStateAsUpdate(d)
      }
      log(`seed ${label} (${text.length} B md): ${((performance.now() - t0) / N).toFixed(1)} ms/seed`)
    }
  })
})
