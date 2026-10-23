/**
 * Resize a block by one of its side grips: images, and diagrams since #476.
 * While the pointer moves the width previews through a CSS custom property on
 * the host; it is written to the node once, on release, so a drag is one undo
 * step and one change for collaborators.
 *
 * `factor` 2 is for a centred block: it grows on both sides, so the grip only
 * keeps up with the pointer if the width moves twice as far.
 */
export function startWidthDrag(
  event: PointerEvent,
  options: { side: 'left' | 'right'; host: HTMLElement; cssVar: string; start: number; min: number; factor?: number },
  commit: (width: number) => void,
) {
  event.preventDefault()
  const { side, host, cssVar, start, min, factor = 1 } = options
  const startX = event.clientX
  const max = host.parentElement?.getBoundingClientRect().width ?? 720
  ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)

  const onMove = (moveEvent: PointerEvent) => {
    const delta = (moveEvent.clientX - startX) * (side === 'left' ? -1 : 1) * factor
    host.style.setProperty(cssVar, `${Math.round(Math.max(min, Math.min(max, start + delta)))}px`)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    const final = host.style.getPropertyValue(cssVar)
    if (final) commit(Number.parseInt(final, 10))
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
