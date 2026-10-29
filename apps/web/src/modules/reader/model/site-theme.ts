import { SITE_FONT_STACKS, normalizeSiteTheme, type SiteTheme } from '@knowledge/contracts/publishing'

/**
 * A site's theme as one `<style>` block (docs/features/44). Values only ever
 * come through `normalizeSiteTheme`: colours are `#rrggbb` and the font is a
 * key into a fixed table, so nothing a site admin types reaches the CSS as
 * text. That is what makes it safe to inline.
 */

/** Relative luminance of a `#rrggbb` colour (WCAG 2.x). */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** White or near-black, whichever reads better on `hex`. */
export function foregroundFor(hex: string): string {
  const l = luminance(hex)
  // Contrast against white vs against #0b0b0f (luminance ≈ 0.0035).
  return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.0535) ? '#ffffff' : '#0b0b0f'
}

function colourVars(hex: string): string {
  return `--primary:${hex};--primary-foreground:${foregroundFor(hex)};--ring:${hex};`
}

export function siteThemeCss(input: SiteTheme): string {
  const theme = normalizeSiteTheme(input)
  const rules: string[] = []
  const light = theme.primaryColor
  const dark = theme.primaryColorDark ?? theme.primaryColor
  // `html:root` / `html.dark` outrank the app's own `:root` / `.dark`, so the
  // theme wins whichever stylesheet the page happens to load last (the built
  // reader links assets/style.css after the head this block goes into).
  if (light) rules.push(`html:root{${colourVars(light)}}`)
  if (dark) rules.push(`html.dark{${colourVars(dark)}}`)
  if (theme.font !== 'system') {
    const stack = SITE_FONT_STACKS[theme.font]
    rules.push(`.kn-site,.kn-site .markdown-body{font-family:${stack}}`)
  }
  return rules.join('')
}
