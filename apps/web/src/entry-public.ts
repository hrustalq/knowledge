import { renderToString } from 'vue/server-renderer'
import {
  buildPageRefResolver,
  isApiErrorPayload,
  pageRefKey,
  type Locale,
  type PublicSharePage,
  type PublicShareResponse,
  type PublicSiteResolveResponse,
  type PublicSiteWidgetResponse,
} from '@knowledge/contracts'
import {
  SITE_VISITOR_TOKEN_PARAM,
  SITE_WIDGET_PATH,
  publicShareAttachmentPath,
  publicSiteAttachmentPath,
  publicSiteSessionPath,
  siteMarkdownPath,
} from '@knowledge/contracts/publishing'
import { formatBytes } from './shared/utils/format'
import { escapeHtml } from './core/markdown/nodes'
import { renderPublicMarkdown, type PublicRenderOptions } from './core/markdown/public-render.server'
import { createPublicApp, readerMessages, siteReaderMessages } from './public-main'
import {
  shareHref,
  siteHomeId,
  siteHref,
  siteThemeCss,
  type PublicReaderState,
  type PublicReaderView,
  type PublicSiteChrome,
} from './modules/reader'

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
 * the share-unlock and site sign-in cookies, the visitor's address and the
 * trace id — never `kn_token`. The API decides everything; this renders what
 * it answered.
 */
export interface PublicRenderContext {
  locale: Locale
  /** `kn_share_<id>=…` and `kn_site_<id>=…` pairs only, already filtered by server.js. */
  shareCookies: string
  /** The visitor as server.js saw them, so the API rate-limits the reader, not this process. */
  forwardedFor: string | null
  traceId: string | null
  /** Set when the request came in on a site's own host: every path is that site's. */
  siteHost?: string | null
  /**
   * The ETag of a render server.js still holds for this host, URL and
   * language. When the API says the page is unchanged, the render stops there
   * and answers `notModified`, and server.js replays what it holds.
   */
  ifNoneMatch?: string | null
}

export interface PublicRenderResult {
  html: string
  head: string
  status: number
  /** Response headers beyond Content-Type; they differ between a share and a site. */
  headers: Record<string, string>
  /** Answer with a redirect instead (a non-canonical page path, or a version switch). */
  redirect?: string
  /** A site page: the API's tag for what this render was made from. Absent = never cache it. */
  etag?: string
  /** `ifNoneMatch` still holds: nothing was rendered; replay the cached render. */
  notModified?: boolean
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
/** The app's own origin: a link on it that is not a page in scope is unlinked (#705). */
const appOrigin = () => process.env.WEB_BASE_URL || null

class ApiAnswer extends Error {
  readonly status: number
  constructor(status: number) {
    super(`public API answered ${status}`)
    this.status = status
  }
}

async function apiGet<T>(path: string, ctx: PublicRenderContext): Promise<T> {
  return (await apiGetTagged<T>(path, ctx)).body!
}

/** A GET that may be conditional: `body` is null when the API answered 304 to `ifNoneMatch`. */
async function apiGetTagged<T>(
  path: string,
  ctx: PublicRenderContext,
  ifNoneMatch?: string | null,
): Promise<{ body: T | null; etag: string | null }> {
  const headers: Record<string, string> = { 'Accept-Language': ctx.locale, Accept: 'application/json' }
  if (ctx.shareCookies) headers.Cookie = ctx.shareCookies
  if (ctx.forwardedFor) headers['X-Forwarded-For'] = ctx.forwardedFor
  if (ctx.traceId) headers['x-request-id'] = ctx.traceId
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch
  const res = await fetch(`${apiInternal()}${path}`, { headers })
  if (res.status === 304) return { body: null, etag: ifNoneMatch ?? null }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null)
    throw new ApiAnswer(isApiErrorPayload(body) ? body.statusCode : res.status)
  }
  return { body: (await res.json()) as T, etag: res.headers.get('etag') }
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
    embedUnavailable: messages.embedUnavailable,
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
      title: page.title,
      pageHref: (id) => (inTree.has(id) ? shareHref(token, id, share.rootDocumentId) : null),
      // Title references resolve among the shared pages only (#705).
      resolvePage: buildPageRefResolver(share.tree),
      appOrigin: appOrigin(),
      attachmentHref: (id, download) => `${apiPublic}${publicShareAttachmentPath(token, id)}${download ? '?download=1' : ''}`,
      embedSrc: (id) => `${apiPublic}/v1/public/shares/${enc}/embeds/${encodeURIComponent(id)}`,
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
        download: share.download,
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

/**
 * The path below the site root, `from` (a version switch) and a visitor's
 * sign-in token (issue #77 phase 3), from a request URL.
 */
function splitSiteUrl(pathAndQuery: string): { path: string; from: string | null; visitorToken: string | null } {
  const q = pathAndQuery.indexOf('?')
  const path = (q === -1 ? pathAndQuery : pathAndQuery.slice(0, q)).split('#')[0]
  const query = q === -1 ? null : new URLSearchParams(pathAndQuery.slice(q + 1))
  const from = query?.get('from') ?? null
  return { path: path || '/', from: from && UUID.test(from) ? from : null, visitorToken: query?.get(SITE_VISITOR_TOKEN_PARAM) || null }
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
  etag?: string
  notModified?: boolean
}

async function resolveSiteView(url: string, ctx: PublicRenderContext): Promise<SiteResolved> {
  const match = ctx.siteHost ? null : SITE_PATH.exec(url)
  const prefix = match ? `/pub/${match[1]}` : ''
  const q = url.indexOf('?')
  const { path, from, visitorToken } = splitSiteUrl(match ? (match[2] || '/') + (q === -1 ? '' : url.slice(q)) : url)
  const notFound: SiteResolved = { view: { kind: 'site-not-found' }, status: 404, description: '', head: [], noindex: true }

  const params = new URLSearchParams({ path })
  if (match) params.set('slug', match[1])
  else if (ctx.siteHost) params.set('host', ctx.siteHost)
  else return notFound
  if (from) params.set('from', from)

  let res: PublicSiteResolveResponse
  let etag: string | null
  try {
    const answer = await apiGetTagged<PublicSiteResolveResponse>(`/v1/public/sites/resolve?${params}`, ctx, ctx.ifNoneMatch)
    if (!answer.body) return { ...notFound, status: 304, notModified: true }
    res = answer.body
    etag = answer.etag
  } catch (err) {
    if (err instanceof ApiAnswer && err.status === 404) return notFound
    throw err
  }

  const { site, version } = res
  const requested = match ? `${prefix}${path}` : path

  // A customer's backend sends a visitor here with `?jwt_token=`: the API's
  // session route checks it, sets the site's cookie on this origin and comes
  // back to the same path without it.
  if (visitorToken) {
    const params = new URLSearchParams({ [SITE_VISITOR_TOKEN_PARAM]: visitorToken, return: requested })
    return { ...notFound, status: 302, redirect: `${apiPublic}${publicSiteSessionPath(site.id)}?${params}` }
  }

  const chrome: PublicSiteChrome = {
    id: site.id,
    title: site.title,
    theme: site.theme,
    logo: site.logo?.kind === 'image' ? { kind: 'image', url: `${apiPublic}${site.logo.url}` } : site.logo,
    prefix,
    version: { slug: version.slug, name: version.name, isDefault: version.isDefault },
    versions: res.versions,
    tree: res.tree,
    viewer: res.viewer,
    // Sign-in comes back to where the reader is: this page's canonical URL,
    // or the path they asked for when it is not one they can see yet.
    signInUrl: res.site.signInUrl
      ? `${res.site.signInUrl}&return=${encodeURIComponent(`${site.rootUrl}${requested.slice(prefix.length) || '/'}`)}`
      : null,
    ask: res.site.ask,
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
  if (from || samePath(requested) !== samePath(canonicalPath)) {
    return { view: { kind: 'not-found' }, status: 302, description: '', head: [], noindex: true, redirect: canonicalPath }
  }

  // The tree no longer names every page (issue #204): the API says where each
  // page this body links to lives, among those this reader may see.
  const slugOf = new Map([...res.tree, ...res.page.links].map((n) => [n.documentId, n.slugPath]))
  // Title references the API resolved among the pages this reader may see (#705).
  const byRef = new Map(res.page.links.flatMap((l) => (l.ref ? [[pageRefKey(l.ref), l.documentId] as const] : [])))
  const body = renderPublicMarkdown(res.page.markdown, {
    title: res.page.title,
    pageHref: (id) => {
      const slugPath = slugOf.get(id)
      return slugPath === undefined ? null : hrefFor(id, slugPath)
    },
    resolvePage: (title) => byRef.get(pageRefKey(title)) ?? null,
    appOrigin: appOrigin(),
    attachmentHref: (id, download) =>
      `${apiPublic}${publicSiteAttachmentPath(site.id, version.id, id)}${download ? '?download=1' : ''}`,
    embedSrc: (id) => `${apiPublic}/v1/public/sites/${site.id}/versions/${version.id}/embeds/${encodeURIComponent(id)}`,
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
        prev: res.page.prev,
        next: res.page.next,
      },
    },
    status: 200,
    description: body.description,
    head,
    noindex,
    ...(etag ? { etag } : {}),
  }
}

/**
 * The Ask widget's frame (issue #77 phase 3): `<site>/_widget`, on the site's
 * host or under `/pub/<slug>`. The site, if it answers questions, or null.
 * A top-level page slugged `_widget` is shadowed by it.
 */
function widgetSite(url: string, ctx: PublicRenderContext): { slug: string } | { host: string } | null {
  const match = ctx.siteHost ? null : SITE_PATH.exec(url)
  const path = (match ? match[2] || '/' : url).split(/[?#]/)[0].replace(/\/+$/, '')
  if (path !== SITE_WIDGET_PATH) return null
  if (match) return { slug: match[1] }
  return ctx.siteHost ? { host: ctx.siteHost } : null
}

/**
 * Who may frame the widget: the site's own origins and the ones its admin
 * listed. Nobody else — the browser refuses the frame, which is the whole of
 * the embed check. Origins come normalized (scheme://host[:port]) from the API.
 */
function frameAncestors(widget: PublicSiteWidgetResponse | null): string {
  if (!widget) return "frame-ancestors 'none'"
  const own = (() => {
    try {
      return new URL(widget.site.rootUrl).origin
    } catch {
      return null
    }
  })()
  const origins = [...new Set([own, ...widget.embedOrigins].filter((o): o is string => !!o && /^https?:\/\/[a-z0-9.:[\]-]+$/i.test(o)))]
  return `frame-ancestors 'self' ${origins.join(' ')}`.trim()
}

async function renderWidget(key: { slug: string } | { host: string }, ctx: PublicRenderContext): Promise<PublicRenderResult> {
  let widget: PublicSiteWidgetResponse | null = null
  try {
    widget = await apiGet<PublicSiteWidgetResponse>(`/v1/public/sites/widget?${new URLSearchParams(key)}`, ctx)
  } catch (err) {
    if (!(err instanceof ApiAnswer && err.status === 404)) throw err
  }
  const site = widget
    ? {
        ...widget.site,
        logo: widget.site.logo?.kind === 'image' ? { kind: 'image' as const, url: `${apiPublic}${widget.site.logo.url}` } : widget.site.logo,
      }
    : null
  const state: PublicReaderState = { locale: ctx.locale, apiBase: apiPublic, view: { kind: 'site-widget', site } }
  const { app } = createPublicApp(state)
  const html = await renderToString(app)
  const messages = siteReaderMessages(ctx.locale)
  const themeCss = site ? siteThemeCss(site.theme) : ''
  const head = [
    `<title>${escapeHtml(site ? messages.askTitle.replace('{site}', site.title) : messages.askWidgetUnavailable)}</title>`,
    '<meta name="robots" content="noindex, nofollow">',
    themeCss ? `<style>${themeCss}</style>` : '',
    stateScript(state),
  ]
    .filter(Boolean)
    .join('\n    ')
  return {
    html,
    head,
    status: site ? 200 : 404,
    headers: {
      'Content-Security-Policy': frameAncestors(widget),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Robots-Tag': 'noindex, nofollow',
    },
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
  const widget = widgetSite(url, ctx)
  if (widget) return renderWidget(widget, ctx)
  const isShare = !ctx.siteHost && SHARE_PATH.test(url)
  const resolved = isShare ? { ...(await resolveShareView(url, ctx)), head: [] as string[], noindex: true } : await resolveSiteView(url, ctx)
  if ('redirect' in resolved && resolved.redirect) {
    // no-referrer: a sign-in redirect's URL carries the visitor's token.
    return {
      html: '',
      head: '',
      status: 302,
      headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
      redirect: resolved.redirect,
    }
  }
  if ('notModified' in resolved && resolved.notModified) {
    return { html: '', head: '', status: 304, headers: {}, notModified: true }
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
        // Revalidated per request: unpublishing must end a site at once.
        'Cache-Control': 'no-cache',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        ...(resolved.noindex ? { 'X-Robots-Tag': 'noindex' } : {}),
      }
  // Only a page served as itself is worth keeping: a 404 inside the site
  // costs no body read, and a share is never cached at all.
  const etag = !isShare && status === 200 && 'etag' in resolved ? resolved.etag : undefined
  return { html, head, status, headers, ...(etag ? { etag } : {}) }
}
