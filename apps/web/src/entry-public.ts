import { renderToString } from 'vue/server-renderer'
import { isApiErrorPayload, type Locale, type PublicSharePage, type PublicShareResponse } from '@knowledge/contracts'
import { publicShareAttachmentPath } from '@knowledge/contracts/publishing'
import { formatBytes } from './lib/format'
import { escapeHtml } from './lib/markdown/nodes'
import { renderPublicMarkdown } from './lib/markdown/public-render.server'
import { createPublicApp, readerMessages } from './public-main'
import { shareHref, type PublicReaderState, type PublicReaderView } from './pages/public/reader-state'

/**
 * The public SSR entry (docs/features/43): `/s/:token[/:documentId]`.
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
}

export interface PublicRenderResult {
  html: string
  head: string
  status: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHARE_PATH = /^\/s\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#].*)?$/

/** Does this request belong to the public renderer? server.js asks before reading any cookie. */
export function isPublicPath(url: string): boolean {
  return SHARE_PATH.test(url)
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

async function resolveView(url: string, ctx: PublicRenderContext): Promise<{ view: PublicReaderView; status: number; description: string }> {
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
    const messages = readerMessages(ctx.locale)
    const body = renderPublicMarkdown(page.markdown, {
      pageHref: (id) => (inTree.has(id) ? shareHref(token, id, share.rootDocumentId) : null),
      attachmentHref: (id, download) => `${apiPublic}${publicShareAttachmentPath(token, id)}${download ? '?download=1' : ''}`,
      labels: {
        onThisPage: messages.onThisPage,
        noHeadings: messages.noHeadings,
        open: messages.open,
        download: messages.download,
        pdfFallback: messages.pdfFallback,
        formatBytes: (n) => formatBytes(n, ctx.locale),
      },
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

/** A name for the <title>, in the reader's language. */
function titleFor(view: PublicReaderView, locale: Locale): string {
  if (view.kind === 'share') return view.page.title
  return readerMessages(locale)[view.kind === 'locked' ? 'lockedTitle' : 'notFoundTitle']
}

export async function render(url: string, ctx: PublicRenderContext): Promise<PublicRenderResult> {
  const { view, status, description } = await resolveView(url, ctx)
  const state: PublicReaderState = { locale: ctx.locale, apiBase: apiPublic, view }
  const { app } = createPublicApp(state)
  const html = await renderToString(app)

  const head = [
    `<title>${escapeHtml(titleFor(view, ctx.locale))}</title>`,
    // A share is for whoever was sent it, never for a search engine — and the
    // token in the URL must not leak through a Referer.
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="referrer" content="no-referrer">',
    description ? `<meta name="description" content="${escapeHtml(description)}">` : '',
    view.kind === 'share' ? `<meta property="og:title" content="${escapeHtml(view.page.title)}">` : '',
    // Escape `<` so page text cannot close the script tag.
    `<script>window.__KN_PUBLIC__ = ${JSON.stringify(state).replace(/</g, '\\u003c')}</script>`,
  ]
    .filter(Boolean)
    .join('\n    ')

  return { html, head, status }
}
