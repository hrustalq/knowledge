import { describe, expect, it } from 'vitest'
import { spliceTemplate } from './splice-template.js'

/**
 * The SSR splice (#1100). What is pinned: rendered text is inserted as itself.
 * A string replacement expands `$&`, `` $` `` and `$'`, so a page title holding
 * one spliced the whole template into every render that listed it.
 */

const TEMPLATE =
  '<!doctype html><html lang="<!--app-lang-->"><head><title>Knowledge</title><!--app-css--><!--app-head--></head>' +
  '<body><div id="app"><!--app-html--></div></body></html>'

describe('spliceTemplate', () => {
  it('fills every placeholder', () => {
    const html = spliceTemplate(TEMPLATE, { lang: 'ru', css: '<style>x</style>', title: 'Home', head: '<meta x>', html: '<p>hi</p>' })
    expect(html).toBe(
      '<!doctype html><html lang="ru"><head><title>Home</title><style>x</style><meta x></head><body><div id="app"><p>hi</p></div></body></html>',
    )
  })

  it.each(['$`', "$'", '$&', '$$', '$1', '$<name>'])('inserts %s literally, once', (pattern) => {
    const head = `<script>window.__PINIA__={"title":"a ${pattern} b"}</script>`
    const html = spliceTemplate(TEMPLATE, { lang: 'en', css: '', title: `a ${pattern} b`, head, html: `<h1>a ${pattern} b</h1>` })
    expect(html.match(/<!doctype/g)).toHaveLength(1)
    expect(html).toContain(head)
    expect(html).toContain(`<h1>a ${pattern} b</h1>`)
    expect(html).toContain(`<title>a ${pattern} b</title>`)
  })

  it('keeps the template title when no title is given', () => {
    expect(spliceTemplate(TEMPLATE, { lang: 'en', css: '', head: null, html: null })).toContain('<title>Knowledge</title>')
  })
})
