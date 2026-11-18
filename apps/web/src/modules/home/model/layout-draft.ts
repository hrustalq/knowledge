import { HOME_WIDGETS, HOME_WIDGET_ZONE, type HomeWidget, type HomeZone } from '@knowledge/contracts'

/** The shown widgets of one zone, in layout order. */
export function inZone(layout: readonly HomeWidget[], zone: HomeZone): HomeWidget[] {
  return layout.filter((w) => HOME_WIDGET_ZONE[w] === zone)
}

/** Customize draws every widget: the shown ones in order, then the hidden ones in catalogue order. */
export function slotsFor(layout: readonly HomeWidget[], zone: HomeZone): HomeWidget[] {
  return [...inZone(layout, zone), ...inZone(HOME_WIDGETS, zone).filter((w) => !layout.includes(w))]
}

/** Swap with the neighbour in the same zone; at an end, unchanged. */
export function moveWidget(layout: readonly HomeWidget[], widget: HomeWidget, step: -1 | 1): HomeWidget[] {
  const zone = inZone(layout, HOME_WIDGET_ZONE[widget])
  const i = zone.indexOf(widget)
  const neighbour = zone[i + step]
  if (i < 0 || !neighbour) return [...layout]
  const out = [...layout]
  const a = out.indexOf(widget)
  const b = out.indexOf(neighbour)
  ;[out[a], out[b]] = [out[b], out[a]]
  return out
}

/** Hide a shown widget; show a hidden one last in its zone. */
export function toggleWidget(layout: readonly HomeWidget[], widget: HomeWidget): HomeWidget[] {
  return layout.includes(widget) ? layout.filter((w) => w !== widget) : [...layout, widget]
}
