/**
 * Media blocks: mermaid source, whiteboard scenes, attachment embeds,
 * external embed groups and resizable images.
 *
 * The specs live in `@knowledge/editor-schema`; this file adds the node views
 * and the insert commands.
 */
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { canonicalEmbedUrl, parseEmbedUrl, type EmbedItem, type EmbedLayout } from '@knowledge/contracts'
import {
  DEFAULT_MERMAID,
  Drawing as DrawingSpec,
  Embed as EmbedSpec,
  FileEmbed as FileEmbedSpec,
  Mermaid as MermaidSpec,
  ResizableImage as ResizableImageSpec,
} from '@knowledge/editor-schema'
import { emptyScene, serializeScene } from '@/core/markdown/drawing'
import MermaidNode from '../nodes/MermaidNode.vue'
import DrawingNode from '../nodes/DrawingNode.vue'
import FileNode from '../nodes/FileNode.vue'
import EmbedNode from '../nodes/EmbedNode.vue'
import ImageNode from '../nodes/ImageNode.vue'

export interface FileEmbedAttributes {
  attachmentId: string
  filename: string
  mime: string
  size: number
  href: string
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    knMedia: {
      setMermaid: (code?: string) => ReturnType
      setDrawing: (scene?: string) => ReturnType
      setFileEmbed: (attrs: FileEmbedAttributes) => ReturnType
    }
    knEmbed: {
      setEmbed: (attrs: EmbedAttributes) => ReturnType
      updateEmbedAt: (pos: number, attrs: EmbedAttributes) => ReturnType
    }
  }
}

export const Mermaid = MermaidSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(MermaidNode)
  },

  addCommands() {
    return {
      setMermaid:
        (code) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { code: code ?? DEFAULT_MERMAID } }),
    }
  },
})

export const Drawing = DrawingSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(DrawingNode)
  },

  addCommands() {
    return {
      setDrawing:
        (scene) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { scene: scene ?? serializeScene(emptyScene()) },
          }),
    }
  },
})

export const FileEmbed = FileEmbedSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(FileNode)
  },

  addCommands() {
    return {
      setFileEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    }
  },
})

export interface EmbedAttributes {
  layout: EmbedLayout
  caption: string
  items: EmbedItem[]
}

export interface EmbedOptions {
  /** Opens the picker on an existing group (the node view's Edit). */
  onEdit: ((pos: number, attrs: EmbedAttributes) => void) | null
  /** A Figma link was pasted alone on an empty line and became a group: pin it. */
  onPasted: ((url: string) => void) | null
}

/**
 * An embed group (#470): its node view, the paste rule and the commands. A
 * Figma URL pasted alone on an empty line becomes a one-item group at once —
 * undo, or the toast's "Keep as link", turns it back. A URL pasted inside a
 * sentence stays a link: only an empty paragraph is a line of its own.
 */
export const Embed = EmbedSpec.extend<EmbedOptions>({
  addOptions() {
    return { onEdit: null, onPasted: null }
  },

  addNodeView() {
    return VueNodeViewRenderer(EmbedNode)
  },

  addCommands() {
    return {
      setEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
      updateEmbedAt:
        (pos, attrs) =>
        ({ tr, state }) => {
          if (state.doc.nodeAt(pos)?.type.name !== this.name) return false
          tr.setNodeMarkup(pos, undefined, attrs)
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    const type = this.type
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey('knEmbedPaste'),
        props: {
          handlePaste(view, event) {
            const text = event.clipboardData?.getData('text/plain')?.trim() ?? ''
            if (!text || /\s/.test(text)) return false
            const ref = parseEmbedUrl(text)
            const { $from, empty } = view.state.selection
            if (!ref || !empty || $from.parent.type.name !== 'paragraph' || $from.parent.content.size > 0) return false
            const url = canonicalEmbedUrl(ref)
            const node = type.create({ layout: 'strip', caption: '', items: [{ url, version: null, caption: '' }] })
            view.dispatch(view.state.tr.replaceWith($from.before(), $from.after(), node).scrollIntoView())
            options.onPasted?.(url)
            return true
          },
        },
      }),
    ]
  },
})

/** Images gain a drag handle; the persisted width is part of the spec. */
export const ResizableImage = ResizableImageSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(ImageNode)
  },
})
