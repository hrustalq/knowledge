import { Decoration, Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { LineSpan } from '@knowledge/editor-schema/markdown'

/**
 * Passage links (#708). The read view's HTML carries each block's line span in
 * the stored body as `data-lines` (`markdownToHtml`'s `lineOffset`); this keeps
 * it on the node, so a block can be linked and a linked span found again from
 * the document rather than from DOM the editor owns. Node views (diagrams) draw
 * no attributes, which is why lookups go through the node, never the element.
 */
const LINED = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'table',
  'codeBlock',
  'blockquote',
  'knPanel',
  'knExpand',
  'knMermaid',
  'knDrawing',
]

declare module '@tiptap/core' {
  interface Storage {
    sourceLines: { passage: LineSpan | null }
  }
  interface Commands<ReturnType> {
    sourceLines: {
      /** Highlight the blocks of a span (null clears). */
      setPassage: (span: LineSpan | null) => ReturnType
    }
  }
}

function spanOf(node: PMNode): LineSpan | null {
  const match = /^(\d+)-(\d+)$/.exec((node.attrs.lines as string | null) ?? '')
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null
}

/** The innermost block with a span at `pos` — a list item, not its list. */
export function linesAt(doc: PMNode, pos: number): LineSpan | null {
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
  for (let depth = $pos.depth; depth > 0; depth--) {
    const span = spanOf($pos.node(depth))
    if (span) return span
  }
  const after = $pos.nodeAfter
  return after ? spanOf(after) : null
}

/**
 * The blocks a span covers: the outermost ones inside it, else (a span cut
 * mid-block) the smallest one overlapping it. Never a guess past the span.
 */
function passageBlocks(doc: PMNode, span: LineSpan): Array<{ pos: number; node: PMNode }> {
  const inside: Array<{ pos: number; node: PMNode }> = []
  let overlap: { pos: number; node: PMNode; size: number } | null = null
  doc.descendants((node, pos) => {
    const s = spanOf(node)
    if (!s) return true
    if (s.start >= span.start && s.end <= span.end) {
      inside.push({ pos, node })
      return false
    }
    if (s.start > span.end || s.end < span.start) return false
    const size = s.end - s.start
    if (!overlap || size <= overlap.size) overlap = { pos, node, size }
    return true
  })
  return inside.length ? inside : overlap ? [overlap] : []
}

export const SourceLines = Extension.create({
  name: 'sourceLines',

  addStorage() {
    return { passage: null as LineSpan | null }
  },

  addGlobalAttributes() {
    return [
      {
        types: LINED,
        attributes: {
          lines: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-lines'),
            renderHTML: (attributes) => (attributes.lines ? { 'data-lines': attributes.lines } : {}),
          },
        },
      },
    ]
  },

  addCommands() {
    return {
      setPassage:
        (span) =>
        ({ editor, commands }) => {
          editor.storage.sourceLines.passage = span
          return commands.updateDecorations('sourceLines')
        },
    }
  },

  addDecorations() {
    return {
      // Recomputed on every new document too: the read view re-parses when the
      // page-title roster lands, and the highlight must survive that.
      update: 'document',
      create: ({ editor, state }) => {
        const span = editor.storage.sourceLines.passage
        if (!span) return []
        return passageBlocks(state.doc, span).map(({ pos, node }) =>
          Decoration.Node(pos, pos + node.nodeSize, { class: 'kn-passage-hit' }),
        )
      },
    }
  },
})
