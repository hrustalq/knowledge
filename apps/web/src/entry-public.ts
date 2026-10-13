import { renderToString } from 'vue/server-renderer'
import {
  isApiErrorPayload,
  type Locale,
  type PublicSharePage,
  type PublicShareResponse,
  type PublicSiteResolveResponse,
} from '@knowledge/contracts'
import { publicShareAttachmentPath, publicSiteAttachmentPath, siteMarkdownPath } from '@knowledge/contracts/publishing'
import { formatBytes } from './lib/format'
import { escapeHtml } from './lib/markdown/nodes'
import { renderPublicMarkdown, type PublicRenderOptions } from './lib/markdown/public-render.server'
import { createPublicApp, readerMessages, siteReaderMessages } from './public-main'
import {
  shareHref,
  siteHomeId,
  siteHref,
  type PublicReaderState,
  type PublicReaderView,
  type PublicSiteChrome,
} from './pages/public/reader-state'
import { siteThemeCss } from './pages/public/site-theme'

/**
 * The public SSR entry (docs/features/43, 44):
 * - `/s/:token[/:documentId]` — a share link;
 * - `/pub/:slug/…` — a published site in path mode;
 * - any path on a site's own host (`<slug>.PUBLISH_BASE_DOMAIN` or a verified
 *   custom domain), which server.js recognises and passes as `siteHost`.
 *
 * Its own entry and its own app, beside entry-server.ts, so an anonymous
 * reader never loads the app shell, the stores or a member's credentials.
 * server.js calls it with only what a public render may see: the language,
 * the share-unlock cookies, the visitor's address and the trace id — never
 * `kn_token`. The API decides everything; this renders what it answered.
 */
export interface PublicRenderContext {
  locale: Locale
  /** `kn_share_<id>=…` pairs only, already filtered by server.js. */
  shareCookies: string
  /** The visitor as server.js saw them, so the API rate-limits the reader, not this process. */
  forwardedFor: string | null
  traceId: string | null
  /** Set when the request came in on a site's own host: every path is that site's. */
  siteHost?: string | null
}

export interface PublicRenderResult {
  html: string
  head: string
  status: number
  /** Response headers beyond Content-Type; they differ between a share and a site. */
  headers: Record<string, string>
  /** Answer with a redirect instead (a non-canonical page path, or a version switch). */
  redirect?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARE_PATH = /^\/s\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/
// Kept in step with SITE_PATH in server.js.
const SITE_PATH = /^\/pub\/([a-z0-9-]+)(\/[^?#]*)?(?:[?#].*)?$/

/** Does this request belong to the public renderer? server.js asks before reading any cookie. */
export function isPublicPath(url: string): boolean {
  return SHARE_PATH.test(url) || SITE_PATH.test(url)
}

/** A share must never be indexed, and its token must not leak through a Referer. */
const SHARE_HEADERS = {
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
}

const apiInternal = () => process.env.API_URL_INTERNAL ?? 'http://localhost:3000'
// What the *browser* calls: the same base the app uses (Caddy and the Vite
// proxy both strip `/api`).
const apiPublic = import.meta.env.VITE_API_URL ?? '/api'

class ApiAnswer extends Error {
  readonly status: number
  constructor(status: number) {
    super(`public API answered ${status}`)
    this.status = status
  }
}

async function apiGet<T>(path: string, ctx: PublicRenderContext): Promise<T> {
  const headers: Record<string, string> = { 'Accept-Language': ctx.locale, Accept: 'application/json' }
  if (ctx.shareCookies) headers.Cookie = ctx.shareCookies
  if (ctx.forwardedFor) headers['X-Forwarded-For'] = ctx.forwardedFor
  if (ctx.traceId) headers['x-request-id'] = ctx.traceId
  const res = await fetch(`${apiInternal()}${path}`, { headers })
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new ApiAnswer(isApiErrorPayload(body) ? body.statusCode : res.status)
  }
  return (await res.json()) as T
}

interface ResolvedView {
  view: PublicReaderView
  status: number
  description: string
}

function labelsFor(locale: Locale): PublicRenderOptions['labels'] {
  const messages = readerMessages(locale)
  return {
    onThisPage: messages.onThisPage,
    noHeadings: messages.noHeadings,
    open: messages.open,
    download: messages.download,
    pdfFallback: messages.pdfFallback,
    formatBytes: (n) => formatBytes(n, locale),
  }
}

async function resolveShareView(url: string, ctx: PublicRenderContext): Promise<ResolvedView> {
  const match = SHARE_PATH.exec(url)
  const token = match ? decodeURIComponent(match[1]) : ''
  const requested = match?.[2] ? decodeURIComponent(match[2]) : null
  const notFound = { view: { kind: 'not-found' } as const, status: 404, description: '' }
  if (!token || (requested && !UUID.test(requested))) return notFound

  const enc = encodeURIComponent(token)
  try {
    const share = await apiGet<PublicShareResponse>(`/v1/public/shares/${enc}`, ctx)
    if (share.locked) return { view: { kind: 'locked', token }, status: 200, description: '' }

    const documentId = requested ?? share.rootDocumentId
    const page = await apiGet<PublicSharePage>(`/v1/public/shares/${enc}/pages/${documentId}`, ctx)
    const inTree = new Set(share.tree.map((n) => n.documentId))
    const body = renderPublicMarkdown(page.markdown, {
      pageHref: (id) => (inTree.has(id) ? shareHref(token, id, share.rootDocumentId) : null),
      attachmentHref: (id, download) => `${apiPublic}${publicShareAttachmentPath(token, id)}${download ? '?download=1' : ''}`,
      labels: labelsFor(ctx.locale),
    })
    return {
      view: {
        kind: 'share',
        token,
        title: share.title,
        tree: share.tree,
        treeTruncated: share.treeTruncated,
        expiresAt: share.expiresAt,
        page: { documentId: page.documentId, title: page.title, html: body.html, headings: body.headings, updatedAt: page.updatedAt },
      },
      status: 200,
      description: body.description,
    }
  } catch (err) {
    if (err instanceof ApiAnswer && (err.status === 404 || err.status === 401)) return notFound
    // A 429 from the API, or the API being down, is not "this link is dead".
    throw err
  }
}

/** The path below the site root, and `from` (a version switch), from a request URL. */
function splitSiteUrl(pathAndQuery: string): { path: string; from: string | null } {
  const q = pathAndQuery.indexOf('?')
  const path = (q === -1 ? pathAndQuery : pathAndQuery.slice(0, q)).split('#')[0]
  const from = q === -1 ? null : new URLSearchParams(pathAndQuery.slice(q + 1)).get('from')
  return { path: path || '/', from: from && UUID.test(from) ? from : null }
}

/** Two spellings of one path compare equal: percent-encoding and a trailing slash are not a difference. */
function samePath(p: string): string {
  let decoded = p
  try {
    decoded = decodeURIComponent(p)
  } catch {
    /* malformed escapes compare as written */
  }
  return decoded.replace(/\/+$/, '') || '/'
}

interface SiteResolved extends ResolvedView {
  redirect?: string
  head: string[]
  noindex: boolean
}

async function resolveSiteView(url: string, ctx: PublicRenderContext): Promise<SiteResolved> {
  const match = ctx.siteHost ? null : SITE_PATH.exec(url)
  const prefix = match ? `/pub/${match[1]}` : ''
  const q = url.indexOf('?')
  const { path, from } = splitSiteUrl(match ? (match[2] || '/') + (q === -1 ? '' : url.slice(q)) : url)
  const notFound: SiteResolved = { view: { kind: 'site-not-found' }, status: 404, description: '', head: [], noindex: true }

  const params = new URLSearchParams({ path })
  if (match) params.set('slug', match[1])
  else if (ctx.siteHost) params.set('host', ctx.siteHost)
  else return notFound
  if (from) params.set('from', from)

  let res: PublicSiteResolveResponse
  try {
    res = await apiGet<PublicSiteResolveResponse>(`/v1/public/sites/resolve?${params}`, ctx)
  } catch (err) {
    if (err instanceof ApiAnswer && err.status === 404) return notFound
    throw err
  }

  const { site, version } = res
  const chrome: PublicSiteChrome = {
    id: site.id,
    title: site.title,
    theme: site.theme,
    logo: site.logo?.kind === 'image' ? { kind: 'image', url: `${apiPublic}${site.logo.url}` } : site.logo,
    prefix,
    version: { slug: version.slug, name: version.name, isDefault: version.isDefault },
    versions: res.versions,
    tree: res.tree,
  }
  const themeCss = siteThemeCss(site.theme)
  const baseHead = themeCss ? [`<style>${themeCss}</style>`] : []

  if (!res.page) {
    return { view: { kind: 'site', site: chrome, page: null }, status: 404, description: '', head: baseHead, noindex: true }
  }

  // One URL per page: the home page lives at the version root, every other
  // page at its slug path. Any other path that resolved to a page (its old
  // slug-less form, the default version's own segment, a version switch)
  // redirects there.
  const homeId = siteHomeId(res.tree)
  const hrefFor = (documentId: string, slugPath: string) => siteHref(chrome, chrome.version, slugPath, documentId === homeId)
  const canonicalPath = hrefFor(res.page.documentId, res.page.slugPath)
  const requested = match ? `${prefix}${path}` : path
  if (from || samePath(requested) !== samePath(canonicalPath)) {
    return { view: { kind: 'not-found' }, status: 302, description: '', head: [], noindex: true, redirect: canonicalPath }
  }

  const slugOf = new Map(res.tree.map((n) => [n.documentId, n.slugPath]))
  const body = renderPublicMarkdown(res.page.markdown, {
    pageHref: (id) => {
      const slugPath = slugOf.get(id)
      return slugPath === undefined ? null : hrefFor(id, slugPath)
    },
    attachmentHref: (id, download) =>
      `${apiPublic}${publicSiteAttachmentPath(site.id, version.id, id)}${download ? '?download=1' : ''}`,
    labels: labelsFor(ctx.locale),
  })

  // Search engines get the default version only, and only when the site asks
  // to be indexed: older versions would compete with it for the same query.
  const noindex = !site.seoIndexable || !version.isDefault
  const canonical = `${site.rootUrl}${canonicalPath.slice(prefix.length) || '/'}`
  const markdownUrl = `${site.rootUrl}${siteMarkdownPath('', version.isDefault ? null : version.slug, res.page.slugPath)}`
  const head = [
    ...baseHead,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    `<meta property="og:title" content="${escapeHtml(res.page.title)}">`,
    `<meta property="og:site_name" content="${escapeHtml(site.title)}">`,
    '<meta property="og:type" content="article">',
    `<meta property="og:url" content="${escapeHtml(canonical)}">`,
    body.description ? `<meta property="og:description" content="${escapeHtml(body.description)}">` : '',
    '<meta name="twitter:card" content="summary">',
    // The same page in the site's other versions, and as plain markdown.
    ...res.page.alternates.map(
      (a) => `<link rel="alternate" href="${escapeHtml(`${site.rootUrl}${a.path}`)}" title="${escapeHtml(a.version.name)}">`,
    ),
    `<link rel="alternate" type="text/markdown" href="${escapeHtml(markdownUrl)}">`,
  ]
  return {
    view: {
      kind: 'site',
      site: chrome,
      page: {
        documentId: res.page.documentId,
        title: res.page.title,
        slugPath: res.page.slugPath,
        html: body.html,
        headings: body.headings,
        updatedAt: res.page.updatedAt,
        alternates: res.page.alternates.map((a) => ({ versionSlug: a.version.slug, href: `${prefix}${a.path}` })),
      },
    },
    status: 200,
    description: body.description,
    head,
    noindex,
  }
}

/** A name for the <title>, in the reader's language. */
function titleFor(view: PublicReaderView, locale: Locale): string {
  if (view.kind === 'share') return view.page.title
  if (view.kind === 'site') {
    return `${view.page ? view.page.title : siteReaderMessages(locale).pageNotFoundTitle} — ${view.site.title}`
  }
  if (view.kind === 'site-not-found') return siteReaderMessages(locale).siteNotFoundTitle
  return readerMessages(locale)[view.kind === 'locked' ? 'lockedTitle' : 'notFoundTitle']
}

function stateScript(state: PublicReaderState): string {
  // Escape `<` so page text cannot close the script tag.
  return `<script>window.__KN_PUBLIC__ = ${JSON.stringify(state).replace(/</g, '\\u003c')}</script>`
}

export async function render(url: string, ctx: PublicRenderContext): Promise<PublicRenderResult> {
  const isShare = !ctx.siteHost && SHARE_PATH.test(url)
  const resolved = isShare ? { ...(await resolveShareView(url, ctx)), head: [] as string[], noindex: true } : await resolveSiteView(url, ctx)
  if ('redirect' in resolved && resolved.redirect) {
    return { html: '', head: '', status: 302, headers: { 'Cache-Control': 'no-store' }, redirect: resolved.redirect }
  }
  const { view, status, description } = resolved
  const state: PublicReaderState = { locale: ctx.locale, apiBase: apiPublic, view }
  const { app } = createPublicApp(state)
  const html = await renderToString(app)

  const head = [
    `<title>${escapeHtml(titleFor(view, ctx.locale))}</title>`,
    // A share is for whoever was sent it, never for a search engine — and the
    // token in the URL must not leak through a Referer.
    isShare ? '<meta name="robots" content="noindex, nofollow">' : resolved.noindex ? '<meta name="robots" content="noindex">' : '',
    isShare ? '<meta name="referrer" content="no-referrer">' : '',
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    view.kind === 'share' ? `<meta property="og:title" content="${escapeHtml(view.page.title)}">` : '',
    ...resolved.head,
    stateScript(state),
  ]
    .filter(Boolean)
    .join('\n    ')

  const headers: Record<string, string> = isShare
    ? SHARE_HEADERS
    : {
        // Re-rendered per request: unpublishing must end a site at once.
        'Cache-Control': 'no-cache',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        ...(resolved.noindex ? { 'X-Robots-Tag': 'noindex' } : {}),
      }
  return { html, head, status, headers }
}
