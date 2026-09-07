/**
 * Inline nodes and marks: status lozenges and document mentions.
 *
 * Status is a *mark*, not an atom node, on purpose: the text stays in the
 * paragraph, so it keeps flowing with the sentence, stays editable in place,
 * and — the part that matters — stays visible to the chunker that embeds this
 * page. An atom would have hidden the word inside a node attribute.
 */
import { Mark, Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { KN, isStatusColor, type StatusColor } from '@/lib/markdown/nodes'
import MentionNode from '../nodes/MentionNode.vue'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    knInline: {
      setStatus: (color: StatusColor) => ReturnType
      toggleStatus: (color: StatusColor) => ReturnType
      unsetStatus: () => ReturnType
      insertDocMention: (attrs: { documentId: string; label: string }) => ReturnType
    }
  }
}

export const StatusMark = Mark.create({
  name: 'knStatus',
  inclusive: false,

  addAttributes() {
    return {
      color: {
        default: 'neutral' as StatusColor,
        parseHTML: (element) => {
          const raw = element.getAttribute(KN.status) ?? 'neutral'
          return isStatusColor(raw) ? raw : 'neutral'
        },
        renderHTML: (attributes) => ({ [KN.status]: attributes.color }),
      },
    }
  },

  parseHTML() {
    return [{ tag: `span[${KN.status}]` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0]
  },

  addCommands() {
    return {
      setStatus:
        (color) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      toggleStatus:
        (color) =>
        ({ commands, editor }) =>
          editor.isActive(this.name, { color })
            ? commands.unsetMark(this.name)
            : commands.setMark(this.name, { color }),
      unsetStatus:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    }
  },
})

/**
 * A link to another page in the knowledge base. Serializes to an ordinary
 * `[Title](/documents/<uuid>)` link, so the deterministic relation extractor
 * and the graph keep seeing a normal internal link — the chip is presentation.
 */
export const DocMention = Node.create({
  name: 'knMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      documentId: {
        default: '',
        parseHTML: (element) => element.getAttribute('href')?.replace('/documents/', '') ?? '',
        renderHTML: () => ({}),
      },
      label: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    // Above StarterKit's Link (50): both rules match this <a>, and without the
    // bump the link mark wins and the chip degrades to an underlined link.
    return [{ tag: `a[${KN.mention}]`, priority: 60 }]
  },

  renderHTML({ node }) {
    return [
      'a',
      { href: `/documents/${node.attrs.documentId as string}`, [KN.mention]: '1' },
      node.attrs.label as string,
    ]
  },

  renderText({ node }) {
    return node.attrs.label as string
  },

  addNodeView() {
    return VueNodeViewRenderer(MentionNode)
  },

  addCommands() {
    return {
      insertDocMention:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent([
            { type: this.name, attrs },
            { type: 'text', text: ' ' },
          ]),
    }
  },
})
