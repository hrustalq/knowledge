/**
 * Media blocks: mermaid source, whiteboard scenes, attachment embeds and
 * resizable images.
 *
 * Mermaid and drawings are the only two nodes that serialize into an opaque
 * fence, and only because neither carries prose the ingestion worker could
 * index. Everything with text in it stays text.
 */
import { Node, mergeAttributes } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { KN } from '@/lib/markdown/nodes'
import { emptyScene, serializeScene } from '@/lib/markdown/drawing'
import MermaidNode from '../nodes/MermaidNode.vue'
import DrawingNode from '../nodes/DrawingNode.vue'
import FileNode from '../nodes/FileNode.vue'
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

const DEFAULT_MERMAID = `graph TD
  A[Request] --> B{Cached?}
  B -- yes --> C[Serve]
  B -- no --> D[Compute]
  D --> C`

/** Reads the fence body out of the `<pre>` the markdown renderer emits. */
function preText(element: HTMLElement): string {
  const pre = [...element.querySelectorAll('pre')][0]
  return (pre?.textContent ?? element.textContent ?? '').trim()
}

export const Mermaid = Node.create({
  name: 'knMermaid',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: {
        default: DEFAULT_MERMAID,
        parseHTML: (element) => preText(element as HTMLElement) || DEFAULT_MERMAID,
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [
      { tag: `div[${KN.mermaid}]` },
      // A plain ```mermaid fence pasted as HTML still lands here rather than in
      // the generic code block, which would strip the diagram on save.
      { tag: 'pre > code.language-mermaid', priority: 60, getAttrs: () => ({}) },
    ]
  },

  renderHTML({ node }) {
    return ['div', { [KN.mermaid]: '1' }, ['pre', {}, node.attrs.code as string]]
  },

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

export const Drawing = Node.create({
  name: 'knDrawing',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      scene: {
        default: '',
        parseHTML: (element) =>
          (element as HTMLElement).getAttribute('data-scene') || preText(element as HTMLElement),
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: `div[${KN.drawing}]` }]
  },

  renderHTML({ node }) {
    return ['div', { [KN.drawing]: '1' }, ['pre', {}, (node.attrs.scene as string) || '']]
  },

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

export const FileEmbed = Node.create({
  name: 'knFile',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      attachmentId: {
        default: '',
        parseHTML: (element) => element.getAttribute(KN.file) ?? '',
        renderHTML: (attributes) => ({ [KN.file]: attributes.attachmentId }),
      },
      filename: {
        default: 'attachment',
        parseHTML: (element) => element.getAttribute('data-kn-name') ?? 'attachment',
        renderHTML: (attributes) => ({ 'data-kn-name': attributes.filename }),
      },
      mime: {
        default: 'application/octet-stream',
        parseHTML: (element) => element.getAttribute('data-kn-mime') ?? 'application/octet-stream',
        renderHTML: (attributes) => ({ 'data-kn-mime': attributes.mime }),
      },
      size: {
        default: 0,
        parseHTML: (element) => Number(element.getAttribute('data-kn-size')) || 0,
        renderHTML: (attributes) => (attributes.size ? { 'data-kn-size': String(attributes.size) } : {}),
      },
      href: {
        default: '',
        parseHTML: (element) => element.querySelector('a')?.getAttribute('href') ?? '',
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: `div[${KN.file}]` }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes),
      ['a', { href: node.attrs.href as string }, node.attrs.filename as string],
    ]
  },

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

/**
 * Images gain a persisted width and a drag handle. Width is the one image
 * property markdown cannot carry, so the serializer switches that image to an
 * `<img>` tag — resizing is real authored intent, not a view preference.
 */
export const ResizableImage = Image.extend({
  draggable: true,

  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute('width'),
        renderHTML: (attributes) => (attributes.width ? { width: attributes.width } : {}),
      },
    }
  },

  addNodeView() {
    return VueNodeViewRenderer(ImageNode)
  },
})
