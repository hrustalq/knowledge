/**
 * Identity marks for people, derived rather than uploaded — the product has no
 * avatar storage, and "no picture" must still read as *someone in particular*.
 *
 * Shared because two renderers draw them: the Vue `UserAvatar`, and the
 * comment pin, which is a ProseMirror decoration built with plain DOM and so
 * cannot mount a component. Two implementations would drift, and the same
 * person would be two different colours on one screen.
 */

/** Stable hue per user id. Identity, so it must not depend on the display name. */
export function avatarHue(userId: string): number {
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % 360
  return hash
}

export function avatarColor(userId: string): string {
  return `hsl(${avatarHue(userId)} 55% 45%)`
}

/**
 * The same identity, for a face too small to carry white initials at the
 * normal shade. A 14px avatar puts two letters at 8px, where 55%/45% measures
 * 2.6:1 — legible as a colour, not as letters. The hue is unchanged, so the
 * dot on a comment pin and the avatar in the discussion it opens are still
 * recognisably the same person.
 */
export function avatarColorDeep(userId: string): string {
  return `hsl(${avatarHue(userId)} 60% 30%)`
}

/**
 * Up to two letters. Falls back to the id when there is no name to read.
 *
 * Only word characters count as initials. Splitting on whitespace alone made
 * "Dev (AUTH_MODE=none)" render as `D(` — a bracket is not an initial, and the
 * larger avatar on the profile page put that two characters wide across the
 * page header. `\p{L}\p{N}` rather than `\w` because the product ships
 * Russian: `\w` is ASCII-only, and every Cyrillic name would fall through it.
 */
export function avatarInitials(label: string): string {
  const words = label.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []
  if (words.length === 0 || label.trim() === 'dev') return 'D'
  const pair = (words[0]?.[0] ?? '') + (words.length > 1 ? (words[1]?.[0] ?? '') : '')
  return pair.toUpperCase()
}
