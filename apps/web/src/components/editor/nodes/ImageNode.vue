<script setup lang="ts">
// Resizable image. The width is persisted (and serialized as an <img> tag,
// since `![]()` has nowhere to put one) because a deliberate resize is authored
// intent, not a viewing preference.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { resolveAssetUrl } from '@/lib/api'
import { ZOOM_ATTR, zoomLabel } from '@/lib/image-gallery'
import { startWidthDrag } from './width-drag'

const props = defineProps(nodeViewProps)
const { t } = useI18n()
const figure = ref<HTMLElement | null>(null)

const src = computed(() => resolveAssetUrl((props.node.attrs.src as string) ?? ''))
const width = computed(() => (props.node.attrs.width ? `${props.node.attrs.width}px` : undefined))

/**
 * Read mode makes the image a button that opens the page's lightbox (#467,
 * the host's ImageLightbox listens for it). Edit mode leaves it alone: there a
 * click selects the node and the grips resize it. A function, not a computed,
 * so it re-reads `isEditable` on the same renders the grips' `v-if` does.
 */
function zoomAttrs() {
  if (props.editor.isEditable) return {}
  return {
    [ZOOM_ATTR]: '',
    tabindex: 0,
    role: 'button',
    'aria-label': zoomLabel(t, (props.node.attrs.alt || props.node.attrs.title || '') as string),
  }
}

function startResize(event: PointerEvent, side: 'left' | 'right') {
  const host = figure.value
  if (!props.editor.isEditable || !host) return
  const start = host.querySelector('img')?.getBoundingClientRect().width ?? 320
  startWidthDrag(event, { side, host, cssVar: '--kn-image-width', start, min: 80 }, (width) =>
    props.updateAttributes({ width }),
  )
}
</script>

<template>
  <NodeViewWrapper
    ref="figure"
    class="kn-image"
    :data-selected="selected"
    :style="{ '--kn-image-width': width }"
  >
    <!-- Lazy and off the main thread: a long page's images below the fold
         neither compete with the text for bandwidth nor block a frame to
         decode. No intrinsic size to reserve space with — markdown stores none
         (only an authored `width`), so see editor-schema's ResizableImage. -->
    <img
      :src="src"
      :alt="node.attrs.alt ?? ''"
      :title="node.attrs.title ?? undefined"
      loading="lazy"
      decoding="async"
      draggable="false"
      v-bind="zoomAttrs()"
    />
    <template v-if="editor.isEditable">
      <span class="kn-resize-grip" data-side="left" @pointerdown="startResize($event, 'left')" />
      <span class="kn-resize-grip" data-side="right" @pointerdown="startResize($event, 'right')" />
    </template>
  </NodeViewWrapper>
</template>
