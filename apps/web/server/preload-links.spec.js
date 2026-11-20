import { describe, expect, it } from 'vitest'
import { createPreloadLinks } from './preload-links.js'

/**
 * Route preloads (#1332). What is pinned: a render preloads its own chunks,
 * their static imports and CSS, and nothing the shell already loads or that
 * another route needs.
 */

const manifest = {
  'index.html': { file: 'assets/main-1.js', imports: ['_vue-1.js'] },
  '_vue-1.js': { file: 'assets/vue-1.js' },
  'src/pages/A.vue': { file: 'assets/A-1.js', imports: ['index.html', '_vue-1.js', '_shared-1.js'], css: ['assets/A-1.css'] },
  'src/pages/B.vue': { file: 'assets/B-1.js', imports: ['_shared-1.js'] },
  '_shared-1.js': { file: 'assets/shared-1.js', imports: ['_vue-1.js'], css: ['assets/shared-1.css'] },
  'src/catalog.en.ts': { file: 'assets/catalog.en-1.js', imports: ['_en-1.js'] },
  '_en-1.js': { file: 'assets/en-1.js' },
}
const ssrManifest = {
  'src/app/App.vue': [],
  'src/pages/A.vue': ['/assets/A-1.js', '/assets/A-1.css'],
  'src/pages/B.vue': ['/assets/B-1.js'],
  'src/catalog.en.ts': ['/assets/catalog.en-1.js'],
  'src/logo.svg': ['/assets/logo-1.svg'],
}
const template =
  '<script type="module" crossorigin src="/assets/main-1.js"></script><link rel="modulepreload" crossorigin href="/assets/vue-1.js">'

const preload = createPreloadLinks({ ssrManifest, manifest, template })

describe('createPreloadLinks', () => {
  it("preloads the route's chunk, its CSS, its static imports and the catalogue, never the shell's", () => {
    expect(preload(new Set(['src/app/App.vue', 'src/pages/A.vue', 'src/catalog.en.ts']))).toBe(
      '<link rel="modulepreload" crossorigin href="/assets/A-1.js">' +
        '<link rel="modulepreload" crossorigin href="/assets/shared-1.js">' +
        '<link rel="preload" as="style" crossorigin href="/assets/shared-1.css">' +
        '<link rel="preload" as="style" crossorigin href="/assets/A-1.css">' +
        '<link rel="modulepreload" crossorigin href="/assets/catalog.en-1.js">' +
        '<link rel="modulepreload" crossorigin href="/assets/en-1.js">',
    )
  })

  it('names each file once and nothing of a route it did not render', () => {
    const html = preload(['src/pages/B.vue', 'src/pages/B.vue'])
    expect(html).not.toContain('A-1')
    expect(html.match(/shared-1\.js/g)).toHaveLength(1)
  })

  it('emits nothing for an unknown module, an asset or no modules at all', () => {
    expect(preload(['src/gone.vue', 'src/logo.svg'])).toBe('')
    expect(preload(undefined)).toBe('')
  })
})
