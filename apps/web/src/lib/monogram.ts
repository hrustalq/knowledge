/**
 * Deterministic monograms for scope rows (workspaces, projects).
 *
 * A scope has no avatar to show, so identity has to come from the name itself:
 * two letters on a hue hashed from the id. It is stable across sessions and
 * machines, which is what makes it scannable — the tile becomes the thing you
 * recognise in a list before you have read the label.
 */

/** Hue in [0,360) hashed from an opaque id; same id, same colour, forever. */
export function hueOf(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

/** First letters of the first two words, or the first two characters. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  return (
    ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() ||
    name.slice(0, 2).toUpperCase()
  )
}
