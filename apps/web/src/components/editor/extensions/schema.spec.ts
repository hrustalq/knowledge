// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { IMAGE_OPTIONS, SCHEMA_VERSION, baseExtensions, parseMarkdown, schemaVersion } from '@knowledge/editor-schema'
import { markdownToHtml } from '@/lib/markdown/render'
import { ApiContract, ApiSection } from './api'
import { Expand, Layout, LayoutColumn, Panel, TableOfContents } from './blocks'
import { AgentMention, DocMention, StatusMark, UserMention } from './inline'
import { Drawing, Embed, FileEmbed, Mermaid, ResizableImage } from './media'

// The schema-bearing half of RichEditor's extension list, with the web's
// view-bearing copies. The API seeds shared drafts from @knowledge/editor-schema
// (#80); if these two disagree, y-prosemirror silently drops what one side
// does not know.
const webSchema = getSchema([
  ...baseExtensions(),
  Panel,
  Expand,
  Layout,
  LayoutColumn,
  TableOfContents,
  ApiContract,
  ApiSection,
  Mermaid,
  Drawing,
  FileEmbed,
  Embed,
  ResizableImage.configure(IMAGE_OPTIONS),
  StatusMark,
  DocMention,
  UserMention,
  AgentMention,
])

const PAGE = `> [!tip]
> A **panel**.

<details>
<summary>More</summary>

Body.

</details>

<div data-kn-layout="2">
<div data-kn-col>

Left

</div>
<div data-kn-col>

Right

</div>
</div>

<div data-kn-api="GET" data-kn-path="/x">

### GET /x

<div data-kn-api-section="summary">

Gets x.

</div>

</div>

<img src="/v1/attachments/i1" alt="d" width="320" />

State: <span data-kn-status="red">DOWN</span>, see [Page](/documents/00000000-0000-4000-8000-000000000001).
`

describe('editor schema split (#80)', () => {
  it('the web extensions build the schema the API seeds with', () => {
    expect(schemaVersion(webSchema)).toBe(SCHEMA_VERSION)
  })

  it('and parse a page into the same document', () => {
    const body = document.createElement('body')
    body.innerHTML = markdownToHtml(PAGE)
    const web = PMDOMParser.fromSchema(webSchema).parse(body)
    expect(web.toJSON()).toEqual(parseMarkdown(PAGE, document).toJSON())
  })
})
