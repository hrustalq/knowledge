/**
 * C4 models in the editor (#1244, docs/features/85). A ```structurizr fence is
 * an ordinary code block — that is what keeps it byte for byte in markdown —
 * so this only gives the code block a node view for that language: the source
 * while editing, the drawing under it, and in a read-only page the drawing
 * alone. Every other code block keeps the schema's own DOM.
 *
 * The code block itself is configured once, in @knowledge/editor-schema's
 * baseExtensions; this re-extends that instance with its options intact.
 */
import type { AnyExtension, Node, NodeViewRenderer } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { C4_LANG } from '@/core/markdown/structurizr'
import C4CodeBlockNode from '../nodes/C4CodeBlockNode.vue'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    knC4: {
      /** A C4 model block holding `source` (see starterModel). */
      setC4: (source: string) => ReturnType
    }
  }
}

function codeBlockView(): NodeViewRenderer {
  const c4 = VueNodeViewRenderer(C4CodeBlockNode, {
    // A block whose language changes away from structurizr is re-created as a plain one.
    update: ({ newNode, updateProps }) => {
      if (newNode.attrs.language !== C4_LANG) return false
      updateProps()
      return true
    },
  })
  return (props) => {
    if (props.node.attrs.language === C4_LANG) return c4(props)
    const { node } = props
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node))
    // Any change of attributes (a language picked, a line range) re-renders it, as with no node view at all.
    return { dom, contentDOM, update: (next) => next.hasMarkup(node.type, node.attrs) }
  }
}

/** baseExtensions with the code block drawing C4 models. */
export function withC4CodeBlocks(extensions: AnyExtension[]): AnyExtension[] {
  return extensions.map((ext) =>
    ext.name === 'codeBlock'
      ? (ext as Node)
          .extend({
            addNodeView: codeBlockView,
            addCommands() {
              return {
                ...this.parent?.(),
                setC4:
                  (source: string) =>
                  ({ commands }) =>
                    commands.insertContent({ type: this.name, attrs: { language: C4_LANG }, content: [{ type: 'text', text: source }] }),
              }
            },
          })
          .configure(ext.options)
      : ext,
  )
}
