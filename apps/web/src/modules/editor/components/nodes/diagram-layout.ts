/**
 * Size and placement of a mermaid block or drawing in the editor (#476), shared
 * by MermaidNode and DrawingNode. The attributes are the read view's own
 * (`data-kn-width`, `data-kn-wrap`, `--kn-diagram-width`), so one stylesheet
 * lays out both and the page reads as it was edited.
 */
import { computed, type Ref } from 'vue'
import type { NodeViewProps } from '@tiptap/vue-3'
import { DIAGRAM_WIDTH_VAR, asDiagramWrap, diagramLayoutAttrs, type DiagramWrap } from '@/core/markdown/nodes'
import { startWidthDrag } from './width-drag'

export function useDiagramLayout(props: NodeViewProps, editing: Ref<boolean>) {
  const wrap = computed(() => asDiagramWrap(props.node.attrs.wrap))

  /** Editing a diagram (its source, or the whiteboard) takes the full column, whatever its layout. */
  const layoutAttrs = computed(() =>
    editing.value ? {} : diagramLayoutAttrs({ width: Number(props.node.attrs.width) || null, wrap: wrap.value }),
  )

  function resize(event: PointerEvent, side: 'left' | 'right') {
    const host = (event.currentTarget as Element).closest<HTMLElement>('.kn-block')
    if (!props.editor.isEditable || !host) return
    // 160px keeps the action bar usable on the narrowest diagram.
    const options = { side, host, cssVar: DIAGRAM_WIDTH_VAR, start: host.getBoundingClientRect().width, min: 160 }
    startWidthDrag(event, { ...options, factor: wrap.value ? 1 : 2 }, (width) => props.updateAttributes({ width }))
  }

  function place(next: DiagramWrap | null) {
    props.updateAttributes({ wrap: next })
  }

  return { wrap, layoutAttrs, resize, place }
}
