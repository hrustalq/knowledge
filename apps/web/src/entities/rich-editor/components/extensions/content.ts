/**
 * Everything a page body is made of, without the tools that write it: the
 * schema's nodes with this app's views, plus the read-time decorations
 * (comment highlights, glossary links, passage lines). `RichEditor` adds its
 * authoring extensions on top; `RichReader` uses this alone (#1280), so one
 * list decides what both can draw and a new block cannot reach one of them only.
 */
import type { AnyExtension } from '@tiptap/core'
import { IMAGE_OPTIONS, baseExtensions } from '@knowledge/editor-schema'
import type { createEditorLowlight } from '../../model/lowlight'
import { ApiContract, ApiSection } from './api'
import { Expand, Layout, LayoutColumn, Panel, TableOfContents } from './blocks'
import { withC4CodeBlocks } from './c4'
import { CommentAnchors, type CommentAnchorsOptions } from './comment-anchors'
import { GlossaryTerms } from './glossary-terms'
import { AgentMention, DocMention, StatusMark, UserMention } from './inline'
import { Drawing, Embed, FileEmbed, Mermaid, ResizableImage } from './media'
import { SourceLines } from './source-lines'

export function contentExtensions(options: {
  lowlight?: ReturnType<typeof createEditorLowlight>
  /** The app's translator: block labels land in stored content, and highlights carry aria-labels. */
  t: CommentAnchorsOptions['t']
  undoRedo?: boolean
  /** The embed group's edit and paste hooks; a reader has neither. */
  embed?: Parameters<typeof Embed.configure>[0]
}): AnyExtension[] {
  const { lowlight, t, undoRedo = true, embed } = options
  return [
    // Shared with the API's headless schema (@knowledge/editor-schema).
    // Its code block also draws ```structurizr C4 models (#1244).
    ...withC4CodeBlocks(baseExtensions(lowlight, { undoRedo })),
    Panel,
    Expand,
    Layout,
    LayoutColumn,
    TableOfContents,
    ApiContract.configure({ t }),
    ApiSection,
    Mermaid,
    Drawing,
    FileEmbed,
    embed ? Embed.configure(embed) : Embed,
    ResizableImage.configure(IMAGE_OPTIONS),
    StatusMark,
    DocMention,
    UserMention,
    AgentMention,
    CommentAnchors.configure({ t }),
    GlossaryTerms,
    SourceLines,
  ]
}
