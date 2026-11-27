import { describe, expect, it } from 'vitest'
import { imageProxyKey, publicImageKeys, publicImagePath } from '@knowledge/contracts/publishing'
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
  title: 'Page',
  pageHref: (id) => (id === IN ? `/s/kp_t/${id}` : null),
  attachmentHref: (id, download) => `/api/v1/public/shares/kp_t/attachments/${id}${download ? '?download=1' : ''}`,
  labels: {
    onThisPage: 'On this page',
    noHeadings: 'No headings',
    open: 'Open',
    download: 'Download',
    pdfFallback: 'Download the PDF',
    embedUnavailable: 'Mockup not available publicly',
    formatBytes: (n) => `${n} B`,
  },
}

describe('renderPublicMarkdown', () => {
  // #1146: the API signs `publicImageKeys` of the body; the renderer must find
  // every external image it draws among them, however the URL was spelled.
  it('sends every external image through the signed proxy, and drops one nobody signed', () => {
    const md = [
      '![a](https://cdn.example.com/a.png "title")',
      '![b](https://cdn.example.com/ä/(1).png)',
      '![c](<https://cdn.example.com/c d.png>)',
      '![d](//cdn.example.com/d.png?x=1&y=2)',
      '![e](https://cdn.example.com/e\\_f.png)',
      '![f](https://cdn.example.com/f.png?q={x}%20y)',
      '<img src="https://cdn.example.com/g.png?a=1&amp;b=2" srcset="https://cdn.example.com/g2.png 2x">',
      '[ref-image]: https://cdn.example.com/h.png',
      '![h][ref-image]',
      '![data](data:image/png;base64,AAAA)',
    ].join('\n\n')
    const signed = new Set(publicImageKeys(md))
    const proxy = (src: string) => {
      const key = imageProxyKey(src)
      return key && signed.has(key) ? `/api${publicImagePath(key, 'sig')}` : null
    }
    const { html } = renderPublicMarkdown(md, { ...options, externalImageSrc: proxy })
    const srcs = [...html.matchAll(/<img[^>]* src="([^"]*)"/g)].map((m) => m[1])
    expect(srcs).toHaveLength(9)
    expect(srcs.filter((s) => !s.startsWith('/api/v1/public/images?url=') && !s.startsWith('data:'))).toEqual([])
    expect(html).not.toContain('srcset')

    const unsigned = renderPublicMarkdown('![x](https://tracker.example.com/p.gif)', { ...options, externalImageSrc: () => null })
    expect(unsigned.html).not.toContain('<img')
    // Without the option (an export), external images stay as written.
    expect(renderPublicMarkdown('![x](https://cdn.example.com/a.png)', options).html).toContain('src="https://cdn.example.com/a.png"')
  })

  it('renders the body and gives headings the same ids the app does', () => {
    const { html, headings } = renderPublicMarkdown('# Install\n\nFirst step.\n\n## Install\n\n## Настройка', options)
    expect(html).toContain('<h1 id="install">Install</h1>')
    expect(headings.map((h) => h.id)).toEqual(['install', 'install-1', 'настройка'])
  })

  it('drops a leading heading that repeats the title the surface already draws, and keeps one that does not (#692)', () => {
    const titled = renderPublicMarkdown('# Install guide\n\nFirst step.\n\n## Setup', { ...options, title: 'install Guide' })
    expect(titled.html).not.toContain('<h1')
    expect(titled.headings.map((h) => h.id)).toEqual(['setup'])
    const other = renderPublicMarkdown('# Overview\n\nFirst step.', { ...options, title: 'Install guide' })
    expect(other.html).toContain('<h1 id="overview">Overview</h1>')
  })

  it('keeps a diagram\'s size and placement on what the reader is served (#476)', () => {
    const { html } = renderPublicMarkdown(
      '```drawing width=320 wrap=left\n{"v":1,"w":720,"h":300,"els":[]}\n```\n\n```mermaid wrap=right\ngraph TD; A-->B\n```',
      options,
    )
    expect(html).toMatch(/<div class="kn-drawing-canvas" data-kn-width="320" style="--kn-diagram-width: 320px" data-kn-wrap="left">/)
    // Mermaid is drawn in the browser (PublicMarkdown), so its block carries the layout until then.
    expect(html).toMatch(/<div data-kn-mermaid="1" data-kn-wrap="right">/)
  })

  it('serves a sized mermaid block with its width, though the sanitizer strips inline style (#1098)', () => {
    const { html } = renderPublicMarkdown('```mermaid width=480\ngraph TD; A-->B\n```', options)
    expect(html).toMatch(/<div data-kn-mermaid="1" data-kn-width="480" style="--kn-diagram-width: 480px">/)
  })

  it('keeps a PlantUML block and its source for the reader to draw (#1388)', () => {
    const { html } = renderPublicMarkdown('```plantuml width=480 wrap=right\n@startuml\nA -> B : hi\n@enduml\n```', options)
    // The block and its layout survive sanitizing; the source is still inside the <pre>.
    expect(html).toMatch(/<div data-kn-plantuml="1" data-kn-width="480" data-kn-wrap="right" style="--kn-diagram-width: 480px">/)
    expect(html).toContain('@startuml\nA -&gt; B : hi\n@enduml')
    expect(html).toContain('<pre')
  })

  it('drops style and form markup a page carries (#1098)', () => {
    const { html } = renderPublicMarkdown('x\n\n<style>body{display:none}</style>\n\n<form action="https://evil.example/"><button>Go</button></form>\n\n<div style="position:fixed">y</div>', options)
    expect(html).not.toMatch(/<style|<form|<button|position:fixed/)
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

  it('shows an embed\'s captions and the placeholder, and never a link (#470)', () => {
    const { html } = renderPublicMarkdown(
      '<figure data-kn-embed="grid"><a>Sign-in</a><a data-kn-item="44444444-4444-4444-8444-444444444444">Error</a><figcaption>Flow</figcaption></figure>',
      options,
    )
    expect(html).not.toContain('<a')
    expect(html).toContain('Sign-in')
    expect(html.match(/Mockup not available publicly/g)).toHaveLength(2)
    expect(html).toContain('<figcaption class="kn-embed-figcaption">Flow</figcaption>')
  })

  it('shows a snapshot where the API handed out an item id and the caller has a route for it', () => {
    const { html } = renderPublicMarkdown(
      '<figure data-kn-embed="strip"><a>Sign-in</a><a data-kn-item="44444444-4444-4444-8444-444444444444">Error</a></figure>',
      { ...options, embedSrc: (id) => `/api/v1/public/shares/kp_t/embeds/${id}` },
    )
    expect(html).toContain('<img src="/api/v1/public/shares/kp_t/embeds/44444444-4444-4444-8444-444444444444" alt="Error"')
    expect(html.match(/Mockup not available publicly/g)).toHaveLength(1)
  })

  it('drops a caption that is a URL, as raw markdown spells an uncaptioned item (#470)', () => {
    const { html } = renderPublicMarkdown(
      '<figure data-kn-embed><a href="https://www.figma.com/board/AbCdEfGhIj12/">https://www.figma.com/board/AbCdEfGhIj12/</a></figure>',
      options,
    )
    expect(html).not.toContain('figma.com')
    expect(html).toContain('Mockup not available publicly')
  })
  describe('page links, however they are spelled (#705)', () => {
    const APP = 'https://kb.example'
    const linking = { ...options, appOrigin: APP, resolvePage: (t: string) => (t.toLowerCase() === 'shared page' ? IN : t === 'Hidden page' ? OUT : null) }
    const render = (md: string) => renderPublicMarkdown(md, linking).html
    const hrefs = (html: string) => Array.from(html.matchAll(/href="([^"]*)"/g), (m) => m[1])

    it.each([
      ['an absolute app URL', `${APP}/documents/${IN}`, `/s/kp_t/${IN}`],
      ['an absolute URL with a query and fragment', `${APP}/documents/${IN}?branch=x#setup`, `/s/kp_t/${IN}#setup`],
      ['a relative link with a query', `/documents/${IN}?branch=x`, `/s/kp_t/${IN}`],
      ['a relative sub-path', `/documents/${IN}/revisions`, `/s/kp_t/${IN}`],
      ['a percent-encoded title', 'Shared%20Page', `/s/kp_t/${IN}`],
    ])('links %s to a page in scope', (_, href, expected) => {
      expect(hrefs(render(`See [it](${href}).`))).toEqual([expected])
    })

    it('links a title reference with spaces to a page in scope', () => {
      expect(hrefs(render('See [it](Shared Page).'))).toEqual([`/s/kp_t/${IN}`])
    })

    it.each([
      ['an absolute app URL', `${APP}/documents/${OUT}`],
      ['a relative link with a query', `/documents/${OUT}?branch=x`],
      ['a title reference', 'Hidden%20page'],
      ['an unresolved title', 'Nowhere'],
      ['any other app URL', `${APP}/projects/x`],
    ])('keeps only the text of %s outside the scope', (_, href) => {
      const html = render(`See [it](${href}).`)
      expect(hrefs(html)).toEqual([])
      expect(html).toContain('it')
    })

    it('leaves the target off an absolute link it rewrote, and other sites alone', () => {
      const html = render(`[a](${APP}/documents/${IN}) [b](https://other.example/x)`)
      expect(html).not.toMatch(new RegExp(`<a href="/s/[^"]*"[^>]*target=`))
      expect(hrefs(html)).toEqual([`/s/kp_t/${IN}`, 'https://other.example/x'])
    })
  })
  // #1244: the public reader explores a C4 model in the browser, so it gets the
  // source; an export cannot be clicked, so it gets every view drawn in turn.
  describe('C4 models', () => {
    const md = '```structurizr\nmodel {\n  u = person "User"\n  s = softwareSystem "Shop" {\n    w = container "Web"\n  }\n  u -> w "Buys"\n}\n```'

    it('stay their source for the reader', () => {
      const { html } = renderPublicMarkdown(md, options)
      expect(html).toContain('<code class="language-structurizr">')
      expect(html).not.toContain('data-kn-mermaid')
    })

    it('become one titled mermaid block per view for an export', () => {
      const { html } = renderPublicMarkdown(md, { ...options, staticC4: (type) => `[${type}]` })
      expect(html).not.toContain('language-structurizr')
      expect(html.match(/data-kn-mermaid="1"/g)).toHaveLength(2)
      expect(html).toContain('Shop · [systemContext]')
      expect(html).toContain('Shop · [container]')
    })

    it('draw a laid-out view on the server, no script needed', () => {
      const placed = md.replace('}\n```', '}\nviews {\n  systemContext s {\n    include *\n    // @layout u 0 0, s 0 300\n  }\n}\n```')
      const { html } = renderPublicMarkdown(placed, { ...options, staticC4: (type) => `[${type}]` })
      expect(html).toContain('data-c4-node')
      expect(html).not.toContain('data-kn-mermaid')
    })

    it('keep the source when the model does not parse', () => {
      const broken = '```structurizr\nmodel {\n  c = container "C"\n}\n```'
      expect(renderPublicMarkdown(broken, { ...options, staticC4: String }).html).toContain('language-structurizr')
    })
  })
})
