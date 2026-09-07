<script setup lang="ts">
// Resizable image. The width is persisted (and serialized as an <img> tag,
// since `![]()` has nowhere to put one) because a deliberate resize is authored
// intent, not a viewing preference.
import { computed, ref } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { resolveAssetUrl } from '@/lib/api'

const props = defineProps(nodeViewProps)
const figure = ref<HTMLElement | null>(null)

const src = computed(() => resolveAssetUrl((props.node.attrs.src as string) ?? ''))
const width = computed(() => (props.node.attrs.width ? `${props.node.attrs.width}px` : undefined))

function startResize(event: PointerEvent, side: 'left' | 'right') {
  if (!props.editor.isEditable) return
  event.preventDefault()
  const host = figure.value
  if (!host) return
  const startX = event.clientX
  const startWidth = host.querySelector('img')?.getBoundingClientRect().width ?? 320
  const max = host.parentElement?.getBoundingClientRect().width ?? 720
  const target = event.currentTarget as Element
  target.setPointerCapture?.(event.pointerId)

  const onMove = (moveEvent: PointerEvent) => {
    const delta = (moveEvent.clientX - startX) * (side === 'left' ? -1 : 1)
    const next = Math.round(Math.max(80, Math.min(max, startWidth + delta)))
    host.style.setProperty('--kn-image-width', `${next}px`)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    const final = host.style.getPropertyValue('--kn-image-width')
    if (final) props.updateAttributes({ width: Number.parseInt(final, 10) })
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
</script>

<template>
  <NodeViewWrapper
    ref="figure"
    class="kn-image"
    :data-selected="selected"
    :style="{ '--kn-image-width': width }"
  >
    <img :src="src" :alt="node.attrs.alt ?? ''" :title="node.attrs.title ?? undefined" draggable="false" />
    <template v-if="editor.isEditable">
      <span class="kn-image-grip" data-side="left" @pointerdown="startResize($event, 'left')" />
      <span class="kn-image-grip" data-side="right" @pointerdown="startResize($event, 'right')" />
    </template>
  </NodeViewWrapper>
</template>
