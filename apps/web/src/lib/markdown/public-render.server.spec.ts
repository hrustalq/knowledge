import { describe, expect, it } from 'vitest'
import { renderPublicMarkdown, type PublicRenderOptions } from './public-render.server'

/**
 * The public reader's server-side render (docs/features/43). What is pinned:
 * the body is real HTML on the server, it is sanitized with the app's config,
 * and every link and asset is rewritten into the share's scope — a reference
 * outside it keeps its text and loses its target.
 */

const IN = '11111111-1111-4111-8111-111111111111'
const OUT = '22222222-2222-4222-8222-222222222222'
const ATT = '33333333-3333-4333-8333-333333333333'

const options: PublicRenderOptions = {
  pageHref: (id) => (id === IN ? `/s/kp_t/${id}` : null),
  attachmentHref: (id, download) => `/api/v1/public/shares/kp_t/attachments/${id}${download ? '?download=1' : ''}`,
  labels: {
    onThisPage: 'On this page',
    noHeadings: 'No headings',
    open: 'Open',
    download: 'Download',
    pdfFallback: 'Download the PDF',
    formatBytes: (n) => `${n} B`,
  },
}

describe('renderPublicMarkdown', () => {
  it('renders the body and gives headings the same ids the app does', () => {
    const { html, headings } = renderPublicMarkdown('# Install\n\nFirst step.\n\n## Install\n\n## Настройка', options)
    expect(html).toContain('<h1 id="install">Install</h1>')
    expect(headings.map((h) => h.id)).toEqual(['install', 'install-1', 'настройка'])
  })

  it('sanitizes with the app config: scripts and handlers go, rich-block attributes stay', () => {
    const { html } = renderPublicMarkdown(
      '<img src=x onerror="alert(1)"><script>alert(2)</script>\n\n> [!WARNING]\n> careful',
      options,
    )
    expect(html).not.toMatch(/onerror|<script/i)
    expect(html).toContain('data-kn-panel="warning"')
  })

  it('links a page reference only when the share reaches it, and keeps the text otherwise', () => {
    const { html } = renderPublicMarkdown(`[inside](/documents/${IN}#setup) and [outside](/documents/${OUT}) and [app](/settings/access)`, options)
    expect(html).toContain(`<a href="/s/kp_t/${IN}#setup">inside</a>`)
    expect(html).not.toContain(OUT)
    expect(html).toContain('<span>outside</span>')
    expect(html).not.toContain('/settings/access')
    expect(html).toContain('app')
  })

  it('serves attachments through the public route and drops other member-only images', () => {
    const { html } = renderPublicMarkdown(
      `![diagram](/v1/documents/${IN}/attachments/${ATT}/content)\n\n![face](/v1/users/${IN}/avatar)\n\n![ext](https://example.com/a.png)`,
      options,
    )
    expect(html).toContain(`src="/api/v1/public/shares/kp_t/attachments/${ATT}"`)
    expect(html).not.toContain('/avatar')
    expect(html).toContain('src="https://example.com/a.png"')
    expect(html).not.toContain('/v1/documents/')
  })

  it('keeps external links external and leaves mermaid for the client', () => {
    const { html } = renderPublicMarkdown('[site](https://example.com)\n\n```mermaid\ngraph TD; A-->B\n```', options)
    expect(html).toContain('rel="noopener noreferrer nofollow"')
    expect(html).toContain('data-kn-mermaid="1"')
  })

  it('describes the page by its first paragraph, cut at 160 characters', () => {
    const long = 'word '.repeat(60)
    const { description } = renderPublicMarkdown(`# Title\n\n${long}`, options)
    expect(description.length).toBeLessThanOrEqual(160)
    expect(description.endsWith('…')).toBe(true)
    expect(renderPublicMarkdown('Short **intro**.', options).description).toBe('Short intro.')
  })
})
