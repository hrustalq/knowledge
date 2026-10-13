/**
 * The public reader's page body, rendered to HTML on the server
 * (docs/features/43).
 *
 * The app's read view (MarkdownView) renders nothing during SSR, because
 * DOMPurify needs a DOM and the client has one. That is fine behind a login and
 * useless for a link someone opens cold: the first paint is empty and a crawler
 * that honours nothing else sees no page. So the public entry runs the same
 * parser (`markdownToHtml`) and the same `SANITIZE_CONFIG` here, against a
 * jsdom window — the DOM DOMPurify officially supports — and does the DOM
 * passes MarkdownView does on the client, with two differences that make it
 * public:
 *
 * - Every link and asset is rewritten into the share's own scope. A page
 *   reference to a page the link reaches becomes a reader URL; anything else
 *   internal is unlinked, because nothing behind the app's login is reachable
 *   from here. Attachments go through the public attachment route, never
 *   `resolveAssetUrl` (which appends a member's credential).
 * - Glossary linking and page-title references are off: both need the
 *   workspace's roster, which is exactly what a reader must not learn.
 *
 * Mermaid stays a `[data-kn-mermaid]` block for the client to upgrade.
 *
 * Server-only: imported by entry-public.ts and its spec, never by a component,
 * so jsdom never reaches a browser bundle.
 */
import { JSDOM } from 'jsdom'
import createDOMPurify, { type WindowLike } from 'dompurify'
import { parseAttachmentPath } from '@knowledge/contracts/publishing'
import { markdownToHtml, SANITIZE_CONFIG, slugifyHeading } from './render'
import { parseScene, renderSceneToSvg } from './drawing'
import { KN, attachmentKind, escapeHtml } from './nodes'

export interface PublicHeading {
  id: string
  text: string
  level: number
}

export interface PublicRenderOptions {
  /** The reader URL of a page this link reaches, or null to unlink a reference to it. */
  pageHref: (documentId: string) => string | null
  /** The public URL of an attachment of a page in scope. */
  attachmentHref: (attachmentId: string, download: boolean) => string
  /** Chrome strings, already in the reader's language. */
  labels: {
    onThisPage: string
    noHeadings: string
    open: string
    download: string
    pdfFallback: string
    formatBytes: (bytes: number) => string
  }
}

export interface PublicRenderResult {
  html: string
  headings: PublicHeading[]
  /** The first paragraph as plain text, for `<meta name="description">`. */
  description: string
}

// One window for the process. `renderPublicMarkdown` is synchronous, so two
// renders can never interleave on it, and building a jsdom window per request
// would cost more than the render.
const { window } = new JSDOM('<!doctype html><html><body></body></html>')
const purify = createDOMPurify(window as unknown as WindowLike)

const DESCRIPTION_MAX = 160

export function renderPublicMarkdown(markdown: string, options: PublicRenderOptions): PublicRenderResult {
  const doc = window.document
  const host = doc.createElement('div')
  host.innerHTML = purify.sanitize(markdownToHtml(markdown ?? ''), { ...SANITIZE_CONFIG }) as unknown as string

  const headings = assignHeadingIds(host)
  wrapTables(host, doc)
  rewriteLinks(host, doc, options)
  rewriteImages(host, options)
  renderFiles(host, doc, options)
  renderDrawings(host, doc)
  renderToc(host, doc, headings, options)

  return { html: host.innerHTML, headings, description: describe(host) }
}

function assignHeadingIds(root: HTMLElement): PublicHeading[] {
  const headings: PublicHeading[] = []
  const seen = new Map<string, number>()
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3')) {
    const text = el.textContent ?? ''
    // Same ids as MarkdownView, so a `#section` link copied from the app
    // lands on the same heading here.
    let id = slugifyHeading(text) || 'section'
    const count = seen.get(id) ?? 0
    seen.set(id, count + 1)
    if (count > 0) id = `${id}-${count}`
    el.id = id
    headings.push({ id, text, level: Number(el.tagName[1]) })
  }
  return headings
}

function wrapTables(root: HTMLElement, doc: Document) {
  for (const table of root.querySelectorAll('table')) {
    const wrap = doc.createElement('div')
    wrap.className = 'kn-table-scroll'
    table.replaceWith(wrap)
    wrap.append(table)
  }
}

/** Replace an element with its children: the text stays, the link goes. */
function unwrap(el: Element) {
  el.replaceWith(...Array.from(el.childNodes))
}

function rewriteLinks(root: HTMLElement, doc: Document, options: PublicRenderOptions) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    // File cards rewrite their own links below.
    if (a.closest(`[${KN.file}]`)) continue
    const href = a.getAttribute('href') ?? ''
    const page = /^\/documents\/([0-9a-fA-F-]{36})(#.*)?$/.exec(href)
    if (page) {
      const target = options.pageHref(page[1])
      if (!target) {
        const span = doc.createElement('span')
        span.append(...Array.from(a.childNodes))
        a.replaceWith(span)
        continue
      }
      a.setAttribute('href', target + (page[2] ?? ''))
      a.removeAttribute(KN.mention)
      continue
    }
    const attachment = parseAttachmentPath(href)
    if (attachment) {
      a.setAttribute('href', options.attachmentHref(attachment.attachmentId, false))
      continue
    }
    // Anything else on this origin is the app, behind its login.
    if (href.startsWith('/') && !href.startsWith('//')) unwrap(a)
  }
}

function rewriteImages(root: HTMLElement, options: PublicRenderOptions) {
  for (const img of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const src = img.getAttribute('src') ?? ''
    const attachment = parseAttachmentPath(src)
    if (attachment) {
      img.setAttribute('src', options.attachmentHref(attachment.attachmentId, false))
    } else if (src.startsWith('/') && !src.startsWith('//')) {
      // An avatar or any other member-only path: there is nothing to show.
      img.remove()
      continue
    }
    img.setAttribute('loading', 'lazy')
    img.setAttribute('decoding', 'async')
  }
}

function renderFiles(root: HTMLElement, doc: Document, options: PublicRenderOptions) {
  const { labels } = options
  for (const node of root.querySelectorAll<HTMLElement>(`[${KN.file}]`)) {
    const rawHref = node.querySelector('a')?.getAttribute('href') ?? ''
    const attachment = parseAttachmentPath(rawHref)
    if (!attachment) {
      node.remove()
      continue
    }
    const name = node.getAttribute('data-kn-name') ?? 'attachment'
    const mime = node.getAttribute('data-kn-mime') ?? ''
    const size = Number(node.getAttribute('data-kn-size')) || 0
    const href = options.attachmentHref(attachment.attachmentId, false)
    const download = options.attachmentHref(attachment.attachmentId, true)
    const kind = attachmentKind(mime)

    const card = doc.createElement('div')
    card.className = 'kn-block kn-file'
    card.dataset.kind = kind
    card.innerHTML = `
      <div class="kn-file-head">
        <span class="kn-file-glyph" aria-hidden="true">${kind === 'pdf' ? 'PDF' : 'FILE'}</span>
        <span class="kn-file-name">${escapeHtml(name)}</span>
        ${size ? `<span class="kn-file-size">${escapeHtml(labels.formatBytes(size))}</span>` : ''}
        <span class="kn-file-links">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(labels.open)}</a>
          <a href="${escapeHtml(download)}" download="${escapeHtml(name)}">${escapeHtml(labels.download)}</a>
        </span>
      </div>
      ${
        kind === 'pdf'
          ? `<object class="kn-file-pdf" data="${escapeHtml(href)}" type="application/pdf" aria-label="${escapeHtml(name)}"><div class="kn-file-fallback"><a href="${escapeHtml(download)}" download="${escapeHtml(name)}">${escapeHtml(labels.pdfFallback)}</a></div></object>`
          : ''
      }`
    node.replaceWith(card)
  }
}

function renderDrawings(root: HTMLElement, doc: Document) {
  for (const node of root.querySelectorAll<HTMLElement>(`[${KN.drawing}]`)) {
    const wrap = doc.createElement('div')
    wrap.className = 'kn-drawing-canvas'
    wrap.innerHTML = purify.sanitize(renderSceneToSvg(parseScene(node.textContent ?? '')), {
      USE_PROFILES: { svg: true, svgFilters: true },
    }) as unknown as string
    node.replaceWith(wrap)
  }
}

function renderToc(root: HTMLElement, doc: Document, headings: PublicHeading[], options: PublicRenderOptions) {
  for (const node of root.querySelectorAll<HTMLElement>(`[${KN.toc}]`)) {
    const nav = doc.createElement('nav')
    nav.className = 'kn-block kn-toc'
    nav.setAttribute('aria-label', options.labels.onThisPage)
    nav.innerHTML = `<div class="kn-toc-head">${escapeHtml(options.labels.onThisPage)}</div>${
      headings.length
        ? `<ol class="kn-toc-list">${headings
            .map((h) => `<li data-level="${h.level}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`)
            .join('')}</ol>`
        : `<p class="kn-toc-empty">${escapeHtml(options.labels.noHeadings)}</p>`
    }`
    node.replaceWith(nav)
  }
}

function describe(root: HTMLElement): string {
  const text = (root.querySelector('p')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : text
}
