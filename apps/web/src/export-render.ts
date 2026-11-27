import type { ExportRenderPage, ExportRenderRequest, ExportRenderResponse, Locale } from '@knowledge/contracts'
import { EXPORT_PRINT_READY_FLAG } from '@knowledge/contracts/publishing'
import { formatBytes, formatDate, pluralCategory } from './shared/utils/format'
import { escapeHtml, KN } from './core/markdown/nodes'
import { mermaidConfig } from './shared/utils/mermaid'
import { plantumlClassicScript } from './shared/utils/plantuml'
import { renderPublicMarkdown, type PublicRenderOptions } from './core/markdown/public-render.server'
// The reader's catalog: an export is read by whoever it is handed to, like a share.
import en from './shared/i18n/reader/en.json'
import ruCatalog from './shared/i18n/reader/ru.json'
import tokensCss from '@knowledge/ui/tokens.css?raw'
import editorCss from './assets/styles/editor.css?raw'
import exportCss from './assets/styles/export.css?raw'

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
 * Mermaid and PlantUML are drawn by the browser that opens the file, as in the
 * reader: their bundles ship beside the pages only when a page has a diagram.
 * The PlantUML engine is an ES module, so it ships as the same source with its
 * export statement turned into `window.PlantUML` (`plantumlClassicScript`):
 * a module would not load from `file://`, where the HTML bundle is opened.
 *
 * Server-only (server.js calls it; jsdom must never reach a browser bundle).
 */

const ru: typeof en = ruCatalog

export interface ExportRenderDeps {
  /** mermaid.min.js, read once by server.js and only when a page has a diagram. */
  mermaidScript: () => string
  /** The vendored PlantUML engine, Graphviz, the C4 stdlib and the theme catalogue, read only when a page has a `plantuml` fence. */
  plantuml: () => { engine: string; viz: string; c4: string; themes: string }
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
    embedUnavailable: reader.embedUnavailable,
    formatBytes: (n) => formatBytes(n, locale),
  }
}

function c4Level(locale: Locale): NonNullable<PublicRenderOptions['staticC4']> {
  const { level } = (locale === 'ru' ? ru : en).c4
  return (type) => level[type]
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
 * ceiling, so a hung render cannot hold the conversion until it times out. A
 * page carrying both kinds waits for both: the last one to settle raises it.
 */
function diagramUpgrade({ mermaid, plantuml }: { mermaid: boolean; plantuml: boolean }): string {
  const steps = [mermaid ? MERMAID_STEP : '', plantuml ? PLANTUML_STEP : ''].filter(Boolean)
  return `(function () {
  var left = 0, up = false;
  function finish() {
    if (up || left > 0) return;
    up = true;
    window.${EXPORT_PRINT_READY_FLAG} = true;
  }
  function track(p) {
    left++;
    p.then(function () { left--; finish(); }, function () { left--; finish(); });
  }
  setTimeout(function () { up = true; window.${EXPORT_PRINT_READY_FLAG} = true; }, 30000);
${steps.map((step) => `  track(${step});`).join('\n')}
  finish();
})();
`
}

/** Mermaid, as the reader draws it; an async IIFE the coordinator above tracks. */
const MERMAID_STEP = `(async function () {
    var blocks = Array.prototype.slice.call(document.querySelectorAll('[${KN.mermaid}]'));
    if (!blocks.length || !window.mermaid) return;
    window.mermaid.initialize(${JSON.stringify(mermaidConfig(false))});
    for (var i = 0; i < blocks.length; i++) {
      try {
        var out = await window.mermaid.render('kn-mmd-' + i, blocks[i].textContent || '');
        var figure = document.createElement('div');
        figure.className = 'kn-mermaid-figure';
        figure.innerHTML = out.svg;
        ['${KN.width}', '${KN.wrap}', 'style'].forEach(function (name) {
          if (blocks[i].hasAttribute(name)) figure.setAttribute(name, blocks[i].getAttribute(name));
        });
        blocks[i].replaceWith(figure);
      } catch (e) {
        blocks[i].classList.add('kn-mermaid-broken');
      }
    }
  })()`

/**
 * PlantUML, from the classic engine shipped beside the page. Graphviz loads
 * first (a layout needs it), then the engine; each block renders in turn. An
 * error drawing — the engine returns one for bad syntax — is recognised by its
 * text colour and left as source, as the app leaves it.
 */
const PLANTUML_STEP = `(async function () {
    var blocks = Array.prototype.slice.call(document.querySelectorAll('[${KN.plantuml}]'));
    if (!blocks.length) return;
    var base = window.PLANTUML_STDLIB_BASE || '';
    if (!window.Viz) {
      await new Promise(function (resolve, reject) {
        var viz = document.createElement('script');
        viz.src = base + 'viz-global.js';
        viz.onload = resolve;
        viz.onerror = function () { reject(new Error('viz-global.js')); };
        document.head.appendChild(viz);
      });
    }
    if (!window.PlantUML) {
      await new Promise(function (resolve, reject) {
        var engine = document.createElement('script');
        engine.src = base + 'plantuml-global.js';
        engine.onload = resolve;
        engine.onerror = function () { reject(new Error('plantuml-global.js')); };
        document.head.appendChild(engine);
      });
    }
    if (!window.PlantUML) return;
    var wantsTheme = blocks.some(function (b) { return /^\\s*!theme\\b/m.test(b.textContent || ''); });
    if (wantsTheme && !window.PLANTUML_THEMES) {
      await new Promise(function (resolve, reject) {
        var themes = document.createElement('script');
        themes.src = base + 'themes.js';
        themes.onload = resolve;
        themes.onerror = function () { reject(new Error('themes.js')); };
        document.head.appendChild(themes);
      });
    }
    for (var i = 0; i < blocks.length; i++) {
      await new Promise(function (resolve) {
        window.PlantUML.renderToString(String(blocks[i].textContent || '').split(/\\r\\n|\\r|\\n/), function (svg) {
          if (svg.indexOf('fill="#33FF02"') >= 0) {
            blocks[i].classList.add('kn-plantuml-broken');
            resolve();
            return;
          }
          var figure = document.createElement('div');
          figure.className = 'kn-plantuml-figure';
          figure.innerHTML = svg;
          ['${KN.width}', '${KN.wrap}', 'style'].forEach(function (name) {
            if (blocks[i].hasAttribute(name)) figure.setAttribute(name, blocks[i].getAttribute(name));
          });
          blocks[i].replaceWith(figure);
          resolve();
        }, function () {
          blocks[i].classList.add('kn-plantuml-broken');
          resolve();
        }, { dark: false });
      });
    }
  })()`

/** The PlantUML files an export ships, under `dir`, from the vendored engine. */
function plantumlBundle(deps: ExportRenderDeps, dir: string) {
  const { engine, viz, c4, themes } = deps.plantuml()
  return [
    { path: `${dir}plantuml-global.js`, content: plantumlClassicScript(engine) },
    { path: `${dir}viz-global.js`, content: viz },
    { path: `${dir}c4.min.js`, content: c4 },
    { path: `${dir}themes.js`, content: themes },
  ]
}

const hasMermaid = (html: string) => html.includes(KN.mermaid)
const hasPlantuml = (html: string) => html.includes(KN.plantuml)

// ------------------------------------------------------------------ PDF

function renderPdf(req: ExportRenderRequest, deps: ExportRenderDeps): ExportRenderResponse {
  const labels = labelsFor(req.locale)
  const anchor = (documentId: string) => `page-${documentId}`
  const inExport = new Set(req.pages.map((p) => p.documentId))

  const articles = req.pages.map((p, i) => {
    const body = renderPublicMarkdown(p.markdown, {
      title: p.title,
      pageHref: (id) => (inExport.has(id) ? `#${anchor(id)}` : null),
      attachmentHref: (id) => req.assets[id] ?? null,
      // An embedded design's snapshot travels as an asset keyed by its item id (#470).
      embedSrc: (id) => req.assets[id] ?? null,
      // Pages share one document: `#install` on two pages must not collide.
      idPrefix: `p${i}-`,
      labels,
      staticC4: c4Level(req.locale),
    })
    return `<article class="kn-export-page" id="${anchor(p.documentId)}">
      <h1 class="kn-export-page-title">${escapeHtml(p.title)}</h1>
      <div class="markdown-body">${body.html}</div>
    </article>`
  })
  const html = articles.join('\n')
  const mermaid = hasMermaid(html)
  const plantuml = hasPlantuml(html)

  const body = [
    '<main class="kn-export-shell">',
    // One page prints as itself; a cover and a contents page are for many.
    req.pages.length > 1 ? cover(req) : '',
    req.pages.length > 1 ? contents(req, (p) => `#${anchor(p.documentId)}`) : '',
    html,
    '</main>',
    mermaid ? '<script src="mermaid.min.js"></script>' : '',
    plantuml ? `<script>window.PLANTUML_STDLIB_BASE = 'plantuml/';</script>` : '',
    `<script>${diagramUpgrade({ mermaid, plantuml })}</script>`,
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
  if (plantuml) files.push(...plantumlBundle(deps, 'plantuml/'))
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

/**
 * The href from one file of the bundle to a directory, ending with `/` — the
 * shape `PLANTUML_STDLIB_BASE` wants (it is a plain URL prefix).
 */
export function relativeDir(from: string, to: string): string {
  return `${relativeHref(from, `${to}/x`).split('/').slice(0, -1).join('/')}/`
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
      title: page.title,
      pageHref: (id) => {
        const target = pathOf.get(id)
        return target ? relativeHref(page.path, target) : null
      },
      attachmentHref: (id) => (req.assets[id] ? relativeHref(page.path, req.assets[id]) : null),
      embedSrc: (id) => (req.assets[id] ? relativeHref(page.path, req.assets[id]) : null),
      labels,
      staticC4: c4Level(req.locale),
    }),
  )
  const mermaid = rendered.some((r) => hasMermaid(r.html))
  const plantuml = rendered.some((r) => hasPlantuml(r.html))

  const headFor = (from: string) =>
    [
      `<link rel="stylesheet" href="${relativeHref(from, `${STATIC}/export.css`)}">`,
      // Inline and before the deferred scripts: the engine reads the base when it resolves a stdlib.
      plantuml ? `<script>window.PLANTUML_STDLIB_BASE = '${relativeDir(from, `${STATIC}/plantuml`)}';</script>` : '',
      mermaid ? `<script defer src="${relativeHref(from, `${STATIC}/mermaid.min.js`)}"></script>` : '',
      mermaid || plantuml ? `<script defer src="${relativeHref(from, `${STATIC}/export.js`)}"></script>` : '',
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
  if (mermaid) files.push({ path: `${STATIC}/mermaid.min.js`, content: deps.mermaidScript() })
  if (mermaid || plantuml) files.push({ path: `${STATIC}/export.js`, content: diagramUpgrade({ mermaid, plantuml }) })
  if (plantuml) files.push(...plantumlBundle(deps, `${STATIC}/plantuml/`))
  return { files }
}
