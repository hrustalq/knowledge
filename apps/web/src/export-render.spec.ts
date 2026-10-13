import { describe, expect, it } from 'vitest'
import type { ExportRenderRequest } from '@knowledge/contracts'
import { relativeHref, renderExport } from './export-render'

/**
 * The export renderer (docs/features/45). What is pinned: an HTML bundle
 * links only relatively, so it opens from a folder; a PDF is one document
 * whose pages keep their anchors apart; an attachment the export did not
 * carry leaves no dangling reference; the mermaid bundle ships only when a
 * diagram needs it; and Gotenberg's ready flag is always raised.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const OUT = '44444444-4444-4444-8444-444444444444'
const IMG = '55555555-5555-4555-8555-555555555555'
const GONE = '66666666-6666-4666-8666-666666666666'
const img = (id: string, doc = A) => `![shot](/v1/documents/${doc}/attachments/${id}/content)`

function request(format: 'html' | 'pdf', over: Partial<ExportRenderRequest> = {}): ExportRenderRequest {
  return {
    format,
    locale: 'en',
    title: 'Handbook',
    exportedAt: '2026-10-13T12:00:00.000Z',
    pages: [
      { documentId: A, title: 'Guides', depth: 0, path: 'pages/guides.html', markdown: `# Install\n\nSee [setup](/documents/${B}#step-2) and [elsewhere](/documents/${OUT}).\n\n${img(IMG)}\n\n${img(GONE)}` },
      { documentId: B, title: 'Setup', depth: 1, path: 'pages/guides/setup.html', markdown: '## Install\n\n[top](#install)' },
      { documentId: C, title: 'FAQ', depth: 0, path: 'pages/faq.html', markdown: 'Questions.' },
    ],
    assets: { [IMG]: format === 'pdf' ? `asset-${IMG}.png` : `assets/${IMG}.png` },
    ...over,
  }
}

const deps = { mermaidScript: () => '/* mermaid */' }
const file = (res: { files: { path: string; content: string }[] }, path: string) => res.files.find((f) => f.path === path)?.content ?? ''

describe('relativeHref', () => {
  it('walks between bundle files from the root, encoding segments', () => {
    expect(relativeHref('index.html', 'pages/a.html')).toBe('pages/a.html')
    expect(relativeHref('pages/a/b.html', 'pages/c.html')).toBe('../c.html')
    expect(relativeHref('pages/a/b.html', 'index.html')).toBe('../../index.html')
    expect(relativeHref('pages/a.html', 'pages/a/b.html')).toBe('a/b.html')
    expect(relativeHref('pages/a.html', 'pages/настройка.html')).toBe(`${encodeURIComponent('настройка')}.html`)
  })
})

describe('renderExport: html bundle', () => {
  const res = renderExport(request('html'), deps)

  it('writes the contents, one file per page and the stylesheet', () => {
    expect(res.files.map((f) => f.path).sort()).toEqual(
      ['_static/export.css', 'index.html', 'pages/faq.html', 'pages/guides.html', 'pages/guides/setup.html'].sort(),
    )
    expect(file(res, 'index.html')).toContain('href="pages/guides/setup.html"')
  })

  it('links pages and assets relatively, and unlinks what the export does not hold', () => {
    const guides = file(res, 'pages/guides.html')
    expect(guides).toContain('href="guides/setup.html#step-2"')
    expect(guides).toContain('src="../assets/' + IMG + '.png"')
    expect(guides).not.toContain(OUT)
    expect(guides).not.toContain(GONE)
    expect(guides).toContain('href="../_static/export.css"')
    expect(guides).not.toMatch(/href="\/|src="\//)
  })

  it('gives a page its breadcrumbs, subpages and neighbours', () => {
    const setup = file(res, 'pages/guides/setup.html')
    expect(setup).toContain('href="../../index.html"')
    expect(setup).toContain('href="../guides.html">Guides</a>')
    expect(setup).toContain('href="../faq.html">FAQ →</a>')
    expect(file(res, 'pages/guides.html')).toContain('kn-export-children')
  })

  it('ships mermaid only when a page draws a diagram', () => {
    expect(res.files.some((f) => f.path.includes('mermaid'))).toBe(false)
    const withDiagram = renderExport(
      request('html', { pages: [{ documentId: A, title: 'Flow', depth: 0, path: 'pages/flow.html', markdown: '```mermaid\ngraph TD; a-->b\n```' }] }),
      deps,
    )
    expect(file(withDiagram, '_static/mermaid.min.js')).toBe('/* mermaid */')
    expect(file(withDiagram, 'pages/flow.html')).toContain('src="../_static/export.js"')
  })
})

describe('renderExport: pdf', () => {
  const res = renderExport(request('pdf'), deps)
  const index = file(res, 'index.html')

  it('is one self-contained document with a footer, flat assets and the ready flag', () => {
    expect(res.files.map((f) => f.path).sort()).toEqual(['footer.html', 'index.html'])
    expect(index).toContain('<style>')
    expect(index).toContain(`src="asset-${IMG}.png"`)
    expect(index).toContain('window.__KN_PRINT_READY__ = true')
    expect(index).not.toContain(GONE)
  })

  it('keeps every page’s anchors apart and links pages within the document', () => {
    expect(index).toContain('id="p0-install"')
    expect(index).toContain('id="p1-install"')
    expect(index).toContain('href="#p1-install"')
    expect(index).toContain(`href="#page-${B}"`)
    expect(index).toContain(`id="page-${C}"`)
  })

  it('prints one page as itself, without a cover or contents', () => {
    const single = file(renderExport(request('pdf', { pages: [request('pdf').pages[2]] }), deps), 'index.html')
    expect(single).not.toContain('kn-export-cover')
    expect(single).not.toContain('kn-export-contents')
  })

  it('waits for diagrams before printing', () => {
    const withDiagram = renderExport(
      request('pdf', { pages: [{ documentId: A, title: 'Flow', depth: 0, path: 'pages/flow.html', markdown: '```mermaid\ngraph TD; a-->b\n```' }] }),
      deps,
    )
    expect(file(withDiagram, 'mermaid.min.js')).toBe('/* mermaid */')
    expect(file(withDiagram, 'index.html')).toContain('mermaid.render')
  })
})
