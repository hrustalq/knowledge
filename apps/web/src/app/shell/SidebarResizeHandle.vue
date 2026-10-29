<script setup lang="ts">
/**
 * The rail's right edge, made draggable.
 *
 * Invisible at rest — the rail already draws a hairline there, and a second
 * permanent line to advertise a control most people use twice is chrome for
 * chrome's sake. It appears on hover after a short delay so merely crossing
 * the boundary on the way to the page does not flash it, and it commits to the
 * accent while it is actually being dragged.
 *
 * It is a `separator` in the window-splitter sense, so the same three moves
 * exist without a pointer: arrows resize, Home/End run to the bounds, and
 * Enter collapses — the keyboard equivalent of dragging past the minimum.
 */
import { useI18n } from 'vue-i18n'
import { RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, useSidebarStore } from '@/stores/sidebar'

const { t } = useI18n()
const sidebar = useSidebarStore()

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  e.preventDefault()

  // Measured from where the grab started rather than from the pointer's
  // absolute x, so the rail never jumps to meet a pointer that landed on the
  // near side of an 8px target.
  const startX = e.clientX
  const startWidth = sidebar.width
  sidebar.beginResize()

  const move = (ev: PointerEvent) => sidebar.dragTo(startWidth + (ev.clientX - startX))
  const end = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
    el.removeEventListener('lostpointercapture', end)
    sidebar.endResize()
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
  // Capture is released implicitly if this element leaves the document, and
  // that path fires neither `pointerup` nor `pointercancel`. Without it a drag
  // interrupted by an unmount would leave the whole app in the resizing state:
  // no easing, no text selection, and a col-resize cursor everywhere.
  el.addEventListener('lostpointercapture', end)
}

function onKeydown(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16
  switch (e.key) {
    case 'ArrowLeft':
      sidebar.nudge(-step)
      break
    case 'ArrowRight':
      sidebar.nudge(step)
      break
    case 'Home':
      sidebar.setWidth(RAIL_MIN)
      break
    case 'End':
      sidebar.setWidth(RAIL_MAX)
      break
    case 'Enter':
    case ' ':
      sidebar.toggle()
      break
    default:
      return
  }
  e.preventDefault()
}
</script>

<template>
  <div
    class="kn-rail-handle absolute inset-y-0 -right-1 z-30 hidden w-2 cursor-col-resize touch-none select-none lg:block"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="t('nav.resizeSidebar')"
    :title="t('nav.resizeSidebarHint')"
    :aria-valuenow="sidebar.width"
    :aria-valuemin="RAIL_MIN"
    :aria-valuemax="RAIL_MAX"
    @pointerdown="onPointerDown"
    @keydown="onKeydown"
    @dblclick="sidebar.setWidth(RAIL_DEFAULT)"
  >
    <span class="kn-rail-handle-line" aria-hidden="true" />
  </div>
</template>
