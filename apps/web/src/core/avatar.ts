/**
 * Identity marks for people, derived rather than uploaded — the product has no
 * avatar storage, and "no picture" must still read as *someone in particular*.
 *
 * Shared because two renderers draw them: the Vue `UserAvatar`, and the
 * comment pin, which is a ProseMirror decoration built with plain DOM and so
 * cannot mount a component. Two implementations would drift, and the same
 * person would be two different colours on one screen.
 */

/**
 * Stable hue per id. Identity, so it must not depend on the display name.
 * Also the hue of project and workspace monograms and of cited sites: one hash,
 * so the same id is never two colours.
 */
export function avatarHue(userId: string): number {
  let hash = 0
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % 360
  return hash
}

/**
 * The colour behind white initials, for a person, a project, a workspace or a
 * cited site: every generated identity mark in the product goes through here.
 */
export function avatarColor(id: string): string {
  return identityShade(avatarHue(id), 55, 45)
}

/**
 * The same identity, deeper, for a face whose initials are tiny (a 14px avatar
 * puts two letters at 8px) or for ink drawn on the shade itself. The hue is
 * unchanged, so the dot on a comment pin and the avatar in the discussion it
 * opens are still recognisably the same person.
 */
export function avatarColorDeep(userId: string): string {
  return identityShade(avatarHue(userId), 60, 30)
}

/**
 * White text must reach 4.5:1 on the mark (WCAG 1.4.3; initials are 9–14px, so
 * the large-text 3:1 allowance never applies). A fixed HSL lightness does not
 * get there: HSL is not perceptual, and at 45% a yellow-green measures 2.3:1
 * while a blue measures 9:1. So the lightness is the asked-for one, lowered
 * only as far as this hue needs. The hue is never touched, which is what keeps
 * an id recognisable, and the hues that already passed render exactly as
 * before. The target leaves headroom over 4.5 for 8-bit rounding.
 */
const MAX_WHITE_LUMINANCE = 1.05 / 4.6 - 0.05

export function identityShade(hue: number, saturation: number, lightness: number): string {
  let l = lightness
  while (l > 0 && hslLuminance(hue, saturation / 100, l / 100) > MAX_WHITE_LUMINANCE) l -= 0.5
  return `hsl(${hue} ${saturation}% ${l}%)`
}

/** WCAG relative luminance of hsl(h s l), with s and l in [0,1]. */
function hslLuminance(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l)
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(8) + 0.0722 * channel(4)
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
