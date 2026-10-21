import type { ExportRenderPage, ExportRenderRequest, ExportRenderResponse, Locale } from '@knowledge/contracts'
import { EXPORT_PRINT_READY_FLAG } from '@knowledge/contracts/publishing'
import { formatBytes, formatDate, pluralCategory } from './lib/format'
import { escapeHtml, KN } from './lib/markdown/nodes'
import { mermaidConfig } from './lib/mermaid'
import { renderPublicMarkdown, type PublicRenderOptions } from './lib/markdown/public-render.server'
// The reader's catalog: an export is read by whoever it is handed to, like a share.
import en from './i18n/reader/en.json'
import ruCatalog from './i18n/reader/ru.json'
import tokensCss from './styles/tokens.css?raw'
import editorCss from './styles/editor.css?raw'
import exportCss from './styles/export.css?raw'

/**
 * An export's HTML (docs/features/45), rendered here because this is where the
 * markdown parser lives: the worker sends the pages it collected and gets back
 * the files to package. Each page body is `renderPublicMarkdown` — the public
 * reader's sanitised server render, with its links and assets rewritten into
 * the export — wrapped in tokens.css + editor.css, the app's own read-view
 * stylesheet, so an exported page looks like the page.
 *
 * - `pdf`: one document, a page break per page, for Gotenberg's Chromium.
 *   Everything it needs is in one flat folder beside index.html.
 * - `html`: an offline site — index.html with the contents, one file per page
 *   with breadcrumbs, subpages and previous/next, every link relative so it
 *   opens from a folder.
 *
 * Mermaid is drawn by the browser that opens the file, as in the reader: the
 * bundle is shipped beside the pages only when a page has a diagram.
 *
 * Server-only (server.js calls it; jsdom must never reach a browser bundle).
 */

const ru: typeof en = ruCatalog

export interface ExportRenderDeps {
  /** mermaid.min.js, read once by server.js and only when a page has a diagram. */
  mermaidScript: () => string
}

const STYLES = `${tokensCss}\n${editorCss}\n${exportCss}`
const STATIC = '_static'

export function renderExport(req: ExportRenderRequest, deps: ExportRenderDeps): ExportRenderResponse {
  return req.format === 'pdf' ? renderPdf(req, deps) : renderBundle(req, deps)
}

function messages(locale: Locale) {
  const catalog = locale === 'ru' ? ru : en
  return { reader: catalog.shareReader, exp: catalog.exportReader }
}

function labelsFor(locale: Locale): PublicRenderOptions['labels'] {
  const { reader } = messages(locale)
  return {
    onThisPage: reader.onThisPage,
    noHeadings: reader.noHeadings,
    open: reader.open,
    download: reader.download,
    pdfFallback: reader.pdfFallback,
    formatBytes: (n) => formatBytes(n, locale),
  }
}

function pageCount(locale: Locale, n: number): string {
  const forms = messages(locale).exp.pageCount
  const form = pluralCategory(n, locale) as keyof typeof forms
  return (forms[form] ?? forms.other).replace('{n}', String(n))
}

function cover(req: ExportRenderRequest): string {
  const { exp } = messages(req.locale)
  return `<header class="kn-export-cover">
      <h1 class="kn-export-title">${escapeHtml(req.title)}</h1>
      <p class="kn-export-meta">${escapeHtml(exp.exportedOn.replace('{date}', formatDate(req.exportedAt, req.locale)))} · ${escapeHtml(pageCount(req.locale, req.pages.length))}</p>
    </header>`
}

function contents(req: ExportRenderRequest, hrefOf: (page: ExportRenderPage) => string): string {
  const { exp } = messages(req.locale)
  const items = req.pages
    .map((p) => `<li style="--depth:${p.depth}"><a href="${escapeHtml(hrefOf(p))}">${escapeHtml(p.title)}</a></li>`)
    .join('')
  return `<nav class="kn-export-contents" aria-label="${escapeHtml(exp.contents)}"><h2>${escapeHtml(exp.contents)}</h2><ol>${items}</ol></nav>`
}

function htmlDocument(locale: Locale, title: string, head: string, body: string): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)}</title>
    ${head}
  </head>
  <body>
    ${body}
  </body>
</html>
`
}

/**
 * Draws every diagram, then raises the flag Gotenberg waits for. The flag goes
 * up whatever happens — a diagram that fails stays its source — and after a
 * ceiling, so a hung render cannot hold the conversion until it times out.
 */
const MERMAID_UPGRADE = `(function () {
  var done = function () { window.${EXPORT_PRINT_READY_FLAG} = true; };
  setTimeout(done, 20000);
  var blocks = Array.prototype.slice.call(document.querySelectorAll('[${KN.mermaid}]'));
  if (!blocks.length || !window.mermaid) return done();
  window.mermaid.initialize(${JSON.stringify(mermaidConfig(false))});
  var i = 0;
  blocks.reduce(function (prev, block) {
    return prev.then(function () {
      return window.mermaid.render('kn-mmd-' + i++, block.textContent || '').then(function (out) {
        var figure = document.createElement('div');
        figure.className = 'kn-mermaid-figure';
        figure.innerHTML = out.svg;
        block.replaceWith(figure);
      }, function () { block.classList.add('kn-mermaid-broken'); });
    });
  }, Promise.resolve()).then(done, done);
})();
`

const hasMermaid = (html: string) => html.includes(KN.mermaid)

// ------------------------------------------------------------------ PDF

function renderPdf(req: ExportRenderRequest, deps: ExportRenderDeps): ExportRenderResponse {
  const labels = labelsFor(req.locale)
  const anchor = (documentId: string) => `page-${documentId}`
  const inExport = new Set(req.pages.map((p) => p.documentId))

  const articles = req.pages.map((p, i) => {
    const body = renderPublicMarkdown(p.markdown, {
      pageHref: (id) => (inExport.has(id) ? `#${anchor(id)}` : null),
      attachmentHref: (id) => req.assets[id] ?? null,
      // Pages share one document: `#install` on two pages must not collide.
      idPrefix: `p${i}-`,
      labels,
    })
    return `<article class="kn-export-page" id="${anchor(p.documentId)}">
      <h1 class="kn-export-page-title">${escapeHtml(p.title)}</h1>
      <div class="markdown-body">${body.html}</div>
    </article>`
  })
  const html = articles.join('\n')
  const mermaid = hasMermaid(html)

  const body = [
    '<main class="kn-export-shell">',
    // One page prints as itself; a cover and a contents page are for many.
    req.pages.length > 1 ? cover(req) : '',
    req.pages.length > 1 ? contents(req, (p) => `#${anchor(p.documentId)}`) : '',
    html,
    '</main>',
    mermaid ? '<script src="mermaid.min.js"></script>' : '',
    `<script>${mermaid ? MERMAID_UPGRADE : `window.${EXPORT_PRINT_READY_FLAG} = true;`}</script>`,
  ].join('\n')

  const files = [
    { path: 'index.html', content: htmlDocument(req.locale, req.title, `<style>${STYLES}</style>`, body) },
    // Gotenberg prints this at the foot of every sheet; its own document, so
    // its own (inline) styles. Chromium lays a footer template out with no
    // width and collapses its inline whitespace, so the number goes in a
    // full-width block: on the body alone it printed as `3/4` at the left edge.
    {
      path: 'footer.html',
      content: `<!doctype html><html><head><style>html,body{margin:0;width:100%}div{width:100%;font:8px ui-sans-serif,system-ui,sans-serif;color:#888;text-align:center}</style></head><body><div><span class="pageNumber"></span> / <span class="totalPages"></span></div></body></html>`,
    },
  ]
  if (mermaid) files.push({ path: 'mermaid.min.js', content: deps.mermaidScript() })
  return { files }
}

// ------------------------------------------------------------------ HTML bundle

/**
 * The href from one file of the bundle to another, both given from the
 * bundle's root: `pages/a/b.html` → `pages/c.html` is `../c.html`. Segments
 * are percent-encoded, since page paths come from titles in any script.
 */
export function relativeHref(from: string, to: string): string {
  const fromDirs = from.split('/').slice(0, -1)
  const toParts = to.split('/')
  let common = 0
  while (common < fromDirs.length && common < toParts.length - 1 && fromDirs[common] === toParts[common]) common++
  const up = '../'.repeat(fromDirs.length - common)
  return up + toParts.slice(common).map(encodeURIComponent).join('/')
}

function renderBundle(req: ExportRenderRequest, deps: ExportRenderDeps): ExportRenderResponse {
  const labels = labelsFor(req.locale)
  const { exp } = messages(req.locale)
  const pathOf = new Map(req.pages.map((p) => [p.documentId, p.path]))

  // Reading order and depth are enough to recover the tree: a page's parent is
  // the nearest page before it one level up.
  const parentOf = new Map<string, ExportRenderPage | null>()
  const childrenOf = new Map<string, ExportRenderPage[]>()
  const stack: ExportRenderPage[] = []
  for (const page of req.pages) {
    while (stack.length && stack[stack.length - 1].depth >= page.depth) stack.pop()
    const parent = stack[stack.length - 1] ?? null
    parentOf.set(page.documentId, parent)
    if (parent) childrenOf.set(parent.documentId, [...(childrenOf.get(parent.documentId) ?? []), page])
    stack.push(page)
  }

  const rendered = req.pages.map((page) =>
    renderPublicMarkdown(page.markdown, {
      pageHref: (id) => {
        const target = pathOf.get(id)
        return target ? relativeHref(page.path, target) : null
      },
      attachmentHref: (id) => (req.assets[id] ? relativeHref(page.path, req.assets[id]) : null),
      labels,
    }),
  )
  const mermaid = rendered.some((r) => hasMermaid(r.html))

  const headFor = (from: string) =>
    [
      `<link rel="stylesheet" href="${relativeHref(from, `${STATIC}/export.css`)}">`,
      mermaid ? `<script defer src="${relativeHref(from, `${STATIC}/mermaid.min.js`)}"></script>` : '',
      mermaid ? `<script defer src="${relativeHref(from, `${STATIC}/export.js`)}"></script>` : '',
    ]
      .filter(Boolean)
      .join('\n    ')

  const link = (from: string, page: ExportRenderPage) =>
    `<a href="${escapeHtml(relativeHref(from, page.path))}">${escapeHtml(page.title)}</a>`

  const files = [
    {
      path: 'index.html',
      content: htmlDocument(
        req.locale,
        req.title,
        headFor('index.html'),
        `<main class="kn-export-shell">${cover(req)}${contents(req, (p) => relativeHref('index.html', p.path))}</main>`,
      ),
    },
    ...req.pages.map((page, i) => {
      const crumbs: ExportRenderPage[] = []
      for (let up = parentOf.get(page.documentId); up; up = parentOf.get(up.documentId)) crumbs.unshift(up)
      const children = childrenOf.get(page.documentId) ?? []
      const prev = req.pages[i - 1]
      const next = req.pages[i + 1]
      const body = `<main class="kn-export-shell">
      <ol class="kn-export-crumbs">
        <li><a href="${escapeHtml(relativeHref(page.path, 'index.html'))}">${escapeHtml(exp.home)}</a></li>
        ${crumbs.map((c) => `<li>${link(page.path, c)}</li>`).join('')}
      </ol>
      <article class="kn-export-page">
        <h1 class="kn-export-page-title">${escapeHtml(page.title)}</h1>
        <div class="markdown-body">${rendered[i].html}</div>
      </article>
      ${
        children.length
          ? `<nav class="kn-export-children"><h2>${escapeHtml(exp.subpages)}</h2><ul>${children.map((c) => `<li>${link(page.path, c)}</li>`).join('')}</ul></nav>`
          : ''
      }
      <nav class="kn-export-pager">
        ${prev ? `<a class="kn-export-prev" href="${escapeHtml(relativeHref(page.path, prev.path))}">← ${escapeHtml(prev.title)}</a>` : ''}
        ${next ? `<a class="kn-export-next" href="${escapeHtml(relativeHref(page.path, next.path))}">${escapeHtml(next.title)} →</a>` : ''}
      </nav>
    </main>`
      return { path: page.path, content: htmlDocument(req.locale, `${page.title} — ${req.title}`, headFor(page.path), body) }
    }),
    { path: `${STATIC}/export.css`, content: STYLES },
  ]
  if (mermaid) {
    files.push({ path: `${STATIC}/mermaid.min.js`, content: deps.mermaidScript() })
    files.push({ path: `${STATIC}/export.js`, content: MERMAID_UPGRADE })
  }
  return { files }
}
