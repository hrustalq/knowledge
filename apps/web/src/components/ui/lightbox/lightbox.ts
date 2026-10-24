/**
 * What the image and diagram lightboxes share (#467, #476): the buttons, and
 * the pan/pinch/zoom model over a full-screen stage.
 *
 * Scale 1 is the content fitted to the stage. The caller says how big that is
 * and how far it may zoom, and draws the scale itself: a transform for a
 * bitmap, a real size for an SVG, which has to stay vector to stay sharp.
 * No pan/zoom library: the whole model is a scale, an offset and a clamp.
 */
import { computed, ref, type Ref } from 'vue'

export const navButton =
  'absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-muted/80 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0'
export const headerButton =
  'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40'

export function usePanZoom(
  stage: Ref<HTMLElement | null>,
  /** The content's drawn size at scale 1. */
  fitted: () => { w: number; h: number },
  /** The largest scale a gesture may reach. */
  max: () => number,
) {
  const scale = ref(1)
  const tx = ref(0)
  const ty = ref(0)
  const dragging = ref(false)
  const zoomed = computed(() => scale.value > 1)

  function reset() {
    scale.value = 1
    tx.value = 0
    ty.value = 0
  }

  /** Never let an edge come further in than the stage's: no empty margin to pan into. */
  function clamp() {
    const box = stage.value
    if (!box) return
    const { w, h } = fitted()
    const mx = Math.max(0, (w * scale.value - box.clientWidth) / 2)
    const my = Math.max(0, (h * scale.value - box.clientHeight) / 2)
    tx.value = Math.min(mx, Math.max(-mx, tx.value))
    ty.value = Math.min(my, Math.max(-my, ty.value))
  }

  /** Scale to `next`, keeping the point under (cx, cy) — the stage's centre by default — where it is. */
  function zoomTo(next: number, cx?: number, cy?: number) {
    const box = stage.value?.getBoundingClientRect()
    if (!box) return
    next = Math.min(max(), Math.max(1, next))
    const fx = (cx ?? box.left + box.width / 2) - (box.left + box.width / 2)
    const fy = (cy ?? box.top + box.height / 2) - (box.top + box.height / 2)
    const k = next / scale.value
    tx.value = fx - (fx - tx.value) * k
    ty.value = fy - (fy - ty.value) * k
    scale.value = next
    clamp()
  }

  // Pointers on the stage. Not captured: a captured pointer retargets the click
  // to the stage, and the click is how a tap on the content is told from a tap
  // beside it. The stage is the whole screen, so the pointer cannot leave it.
  const pointers = new Map<number, { x: number; y: number }>()
  let moved = false

  function onPointerDown(event: PointerEvent) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size === 1) moved = false
  }

  function onPointerMove(event: PointerEvent) {
    const last = pointers.get(event.pointerId)
    if (!last) return
    const [a, b] = [...pointers.values()]
    if (pointers.size === 2 && a && b) {
      const before = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      last.x = event.clientX
      last.y = event.clientY
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      tx.value += mid.x - before.x
      ty.value += mid.y - before.y
      zoomTo((scale.value * d) / (before.d || d), mid.x, mid.y)
      moved = dragging.value = true
      return
    }
    const dx = event.clientX - last.x
    const dy = event.clientY - last.y
    last.x = event.clientX
    last.y = event.clientY
    if (!zoomed.value || (!moved && Math.hypot(dx, dy) < 3)) return
    tx.value += dx
    ty.value += dy
    clamp()
    moved = dragging.value = true
  }

  function onPointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId)
    if (pointers.size === 0) dragging.value = false
  }

  return {
    scale,
    tx,
    ty,
    dragging,
    zoomed,
    reset,
    clamp,
    zoomTo,
    /** The gesture that ended in this click was a drag or a pinch, not a tap. */
    wasDrag: () => moved,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
