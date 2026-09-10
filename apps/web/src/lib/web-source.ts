import { avatarHue } from './avatar'

/**
 * Identity marks for cited websites (docs/features/25).
 *
 * A web citation needs to be recognisable at a glance in a row of them, and
 * the obvious answer — the site's own favicon — is the wrong one here. Every
 * favicon is a request from the reader's browser to the cited site (or worse,
 * to a third-party favicon service), which turns a private page of research
 * notes into a broadcast of what someone is reading. It also fails offline, in
 * dark mode it is whatever the site decided, and it arrives after paint.
 *
 * So a site gets the same derived mark a person gets: a letter and a stable
 * hue hashed from its host. One mechanism draws every identity in the product,
 * it costs no network, and `docs.example.com` is the same colour everywhere it
 * appears in a thread.
 *
 * `avatarHue` is reused rather than re-implemented — it is a stable string→hue
 * hash, and a second one would eventually disagree with the first.
 */
export function siteColor(site: string): string {
  return `hsl(${avatarHue(brandLabel(site))} 55% 45%)`
}

/** The mark's single letter, taken from the brand rather than the subdomain. */
export function siteInitial(site: string): string {
  return (brandLabel(site).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
}

/**
 * Second-level labels that are part of a public suffix rather than a name.
 * Not a public-suffix list — a full one is a megabyte and a dependency, and the
 * cost of being wrong here is one letter on one mark.
 */
const SUFFIX_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'gob', 'or', 'ne'])

/**
 * The label a reader would call the site: `wikipedia` for `en.wikipedia.org`,
 * `mozilla` for `developer.mozilla.org`, `example` for `docs.example.com`.
 *
 * The first label was the obvious choice and the wrong one — it marked
 * Wikipedia with an E and MDN with a D, which is the subdomain's initial and
 * recognises nothing. Deriving both the letter AND the hue from this also means
 * every subdomain of one site shares one mark, which is what a reader expects
 * of `docs.` and `api.` of the same product.
 */
function brandLabel(site: string): string {
  const labels = site.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean)
  if (labels.length <= 1) return labels[0] ?? site
  const secondLast = labels[labels.length - 2]
  // `example.co.uk` — step one further left when the second-level label is
  // itself part of the suffix.
  if (labels.length >= 3 && SUFFIX_LABELS.has(secondLast)) return labels[labels.length - 3]
  return secondLast
}

/**
 * The host as a reader recognises it. Mirrors `displayHost` on the API so a
 * citation reads the same whether it came back from a tool or was derived here.
 */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Path after the host, trimmed for a chip: `/guide/setup` from a long URL.
 * Empty for a bare domain, so the chip shows the host alone rather than a `/`.
 */
export function displayPath(url: string): string {
  try {
    const { pathname, search } = new URL(url)
    const path = (pathname === '/' ? '' : pathname) + search
    return path.length > 42 ? `${path.slice(0, 41)}…` : path
  } catch {
    return ''
  }
}
