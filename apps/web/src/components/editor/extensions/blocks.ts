/**
 * Structural blocks: panels, expands and multi-column layouts.
 *
 * Each node's `renderHTML` is the exact shape `lib/markdown/serialize.ts`
 * expects and `lib/markdown/render.ts` produces. Change one, change all three.
 */
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { KN, PANEL_TYPES, isPanelType, type PanelType } from '@/lib/markdown/nodes'
import PanelNode from '../nodes/PanelNode.vue'
import ExpandNode from '../nodes/ExpandNode.vue'
import LayoutNode from '../nodes/LayoutNode.vue'
import LayoutColumnNode from '../nodes/LayoutColumnNode.vue'
import TocNode from '../nodes/TocNode.vue'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    knBlocks: {
      setPanel: (type: PanelType) => ReturnType
      toggledPanel: (type: PanelType) => ReturnType
      setExpand: () => ReturnType
      setLayout: (columns: 2 | 3) => ReturnType
      setToc: () => ReturnType
    }
  }
}

export const Panel = Node.create({
  name: 'knPanel',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'note' as PanelType,
        parseHTML: (element) => {
          const raw = element.getAttribute(KN.panel) ?? 'note'
          return isPanelType(raw) ? raw : 'note'
        },
        renderHTML: (attributes) => ({ [KN.panel]: attributes.type }),
      },
    }
  },

  parseHTML() {
    return [{ tag: `div[${KN.panel}]` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0]
  },

  addNodeView() {
    return VueNodeViewRenderer(PanelNode)
  },

  addCommands() {
    return {
      setPanel:
        (type) =>
        ({ commands }) =>
          commands.wrapIn(this.name, { type }),
      toggledPanel:
        (type) =>
        ({ commands, editor }) =>
          editor.isActive(this.name, { type })
            ? commands.lift(this.name)
            : commands.wrapIn(this.name, { type }),
    }
  },

  addInputRules() {
    return []
  },

  addKeyboardShortcuts() {
    return {
      // Escape a panel from its last empty paragraph, the way Enter escapes a
      // list — otherwise the only way out is the mouse.
      'Mod-Shift-p': () => this.editor.commands.toggledPanel?.('note') ?? false,
    }
  },
})

/** Panels remember which type each shortcut cycles to. */
export const PANEL_ORDER = PANEL_TYPES

export const Expand = Node.create({
  name: 'knExpand',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      summary: {
        default: 'Details',
        parseHTML: (element) => {
          const summary = [...element.children].find((c) => c.tagName === 'SUMMARY')
          return summary?.textContent?.trim() || 'Details'
        },
        renderHTML: () => ({}),
      },
      open: {
        default: true,
        parseHTML: (element) => element.hasAttribute('open'),
        renderHTML: (attributes) => (attributes.open ? { open: 'open' } : {}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'details',
        // The summary is an attribute, not content — hand ProseMirror a copy
        // with it removed so the label does not also appear inside the body.
        contentElement: (element) => {
          const clone = element.cloneNode(true) as HTMLElement
          for (const child of [...clone.children]) {
            if (child.tagName === 'SUMMARY') child.remove()
          }
          return clone
        },
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes),
      ['summary', {}, node.attrs.summary as string],
      ['div', { 'data-kn-expand-body': '' }, 0],
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(ExpandNode)
  },

  addCommands() {
    return {
      setExpand:
        () =>
        ({ commands }) =>
          commands.wrapIn(this.name),
    }
  },
})

export const LayoutColumn = Node.create({
  name: 'knLayoutColumn',
  content: 'block+',
  isolating: true,

  parseHTML() {
    return [{ tag: `div[${KN.column}]` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { [KN.column]: '' }), 0]
  },

  addNodeView() {
    return VueNodeViewRenderer(LayoutColumnNode)
  },
})

export const Layout = Node.create({
  name: 'knLayout',
  group: 'block',
  content: 'knLayoutColumn{2,3}',
  isolating: true,

  addAttributes() {
    return {
      columns: {
        default: 2,
        parseHTML: (element) => (Number(element.getAttribute(KN.layout)) === 3 ? 3 : 2),
        renderHTML: (attributes) => ({ [KN.layout]: String(attributes.columns) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: `div[${KN.layout}]` }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes), 0]
  },

  addNodeView() {
    return VueNodeViewRenderer(LayoutNode)
  },

  addCommands() {
    return {
      setLayout:
        (columns) =>
        ({ chain }) => {
          const column = { type: 'knLayoutColumn', content: [{ type: 'paragraph' }] }
          return chain()
            .insertContent({
              type: this.name,
              attrs: { columns },
              content: Array.from({ length: columns }, () => column),
            })
            .run()
        },
    }
  },
})

export const TableOfContents = Node.create({
  name: 'knToc',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: `div[${KN.toc}]` }]
  },

  renderHTML() {
    return ['div', { [KN.toc]: '1' }]
  },

  addNodeView() {
    return VueNodeViewRenderer(TocNode)
  },

  addCommands() {
    return {
      setToc:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    }
  },
})
