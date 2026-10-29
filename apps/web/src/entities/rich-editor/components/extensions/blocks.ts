/**
 * Structural blocks: panels, expands and multi-column layouts.
 *
 * The specs (attributes, parse and render rules) live in
 * `@knowledge/editor-schema`, where the API builds the same schema to seed a
 * shared draft. This file adds what only a browser editor has: node views,
 * commands and shortcuts.
 */
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import {
  Expand as ExpandSpec,
  Layout as LayoutSpec,
  LayoutColumn as LayoutColumnSpec,
  Panel as PanelSpec,
  TableOfContents as TocSpec,
} from '@knowledge/editor-schema'
import { PANEL_TYPES, type PanelType } from '@/core/markdown/nodes'
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

export const Panel = PanelSpec.extend({
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

export const Expand = ExpandSpec.extend({
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

export const LayoutColumn = LayoutColumnSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(LayoutColumnNode)
  },
})

export const Layout = LayoutSpec.extend({
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

export const TableOfContents = TocSpec.extend({
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
