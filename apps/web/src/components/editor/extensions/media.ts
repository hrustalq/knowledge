/**
 * Media blocks: mermaid source, whiteboard scenes, attachment embeds,
 * external embed groups and resizable images.
 *
 * The specs live in `@knowledge/editor-schema`; this file adds the node views
 * and the insert commands.
 */
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import {
  DEFAULT_MERMAID,
  Drawing as DrawingSpec,
  Embed as EmbedSpec,
  FileEmbed as FileEmbedSpec,
  Mermaid as MermaidSpec,
  ResizableImage as ResizableImageSpec,
} from '@knowledge/editor-schema'
import { emptyScene, serializeScene } from '@/lib/markdown/drawing'
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

/** An embed group (#470): its node view; inserting one arrives with the picker. */
export const Embed = EmbedSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(EmbedNode)
  },
})

/** Images gain a drag handle; the persisted width is part of the spec. */
export const ResizableImage = ResizableImageSpec.extend({
  addNodeView() {
    return VueNodeViewRenderer(ImageNode)
  },
})
