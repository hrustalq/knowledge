import { describe, expect, it } from 'vitest'
import { avatarColor, avatarHue, identityShade } from './avatar'

/**
 * Contrast is computed here the way a browser and axe do it, independently of
 * the implementation: hsl → 8-bit sRGB (the classic hue2rgb form, not the
 * k-formula `avatar.ts` uses) → WCAG relative luminance → ratio against white.
 */
function whiteContrast(color: string): number {
  const m = /^hsl\((\d+) (\d+(?:\.\d+)?)% (\d+(?:\.\d+)?)%\)$/.exec(color)
  if (!m) throw new Error(`not an hsl() colour: ${color}`)
  const h = Number(m[1]) / 360
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const lin = (c: number) => {
    const v = Math.round(c * 255) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const y =
    0.2126 * lin(hue2rgb(h + 1 / 3)) + 0.7152 * lin(hue2rgb(h)) + 0.0722 * lin(hue2rgb(h - 1 / 3))
  return 1.05 / (y + 0.05)
}

const HUES = Array.from({ length: 360 }, (_, h) => h)

describe('identity colours', () => {
  it('give white initials at least 4.5:1 on every hue, at both shades', () => {
    for (const h of HUES) {
      expect(whiteContrast(identityShade(h, 55, 45)), `hue ${h}`).toBeGreaterThanOrEqual(4.5)
      expect(whiteContrast(identityShade(h, 60, 30)), `deep hue ${h}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keep the hue and saturation, and only ever lower the lightness', () => {
    for (const h of HUES) {
      const [, hue, s, l] = /^hsl\((\d+) (\d+)% ([\d.]+)%\)$/.exec(identityShade(h, 55, 45))!
      expect(Number(hue)).toBe(h)
      expect(Number(s)).toBe(55)
      expect(Number(l)).toBeLessThanOrEqual(45)
    }
  })

  it('leave a hue that already passed exactly as it was', () => {
    // Blue measured 9:1 at 55%/45%; nothing to fix, so nothing moves.
    expect(identityShade(240, 55, 45)).toBe('hsl(240 55% 45%)')
    // The issue's worst case, yellow-green at 2.27:1, is darkened.
    expect(identityShade(62, 55, 45)).not.toBe('hsl(62 55% 45%)')
  })

  it('derive the same hue from an id as before', () => {
    expect(avatarHue('00000000-0000-0000-0000-000000000000')).toBe(96)
    expect(avatarColor('00000000-0000-0000-0000-000000000000')).toMatch(/^hsl\(96 /)
  })
})
