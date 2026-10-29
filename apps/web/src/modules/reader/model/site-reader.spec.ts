import { describe, expect, it } from 'vitest'
import type { PublicSiteTreeNode } from '@knowledge/contracts'
import { siteHomeId, siteHref, treeRows } from './reader-state'
import { createSiteTree } from './site-tree'
import { foregroundFor, siteThemeCss } from './site-theme'

/**
 * The site reader's pure parts (docs/features/44): one URL per page, the home
 * page rule the API's resolve also uses, and a theme that reaches CSS only as
 * validated values.
 */

const node = (documentId: string, slugPath: string, parentId: string | null = null, position = 0): PublicSiteTreeNode => ({
  documentId,
  slugPath,
  parentId,
  position,
  title: documentId,
  childCount: 0,
})

describe('siteHref', () => {
  const latest = { slug: 'latest', name: 'Latest', isDefault: true }
  const v1 = { slug: 'v1', name: 'v1', isDefault: false }

  it('gives the default version no segment of its own, and every other version one', () => {
    expect(siteHref({ prefix: '/pub/acme' }, latest, 'guides/install')).toBe('/pub/acme/guides/install')
    expect(siteHref({ prefix: '/pub/acme' }, v1, 'guides/install')).toBe('/pub/acme/v1/guides/install')
    expect(siteHref({ prefix: '' }, v1, 'guides')).toBe('/v1/guides')
  })

  it('puts the home page at the version root, not under its own slug', () => {
    expect(siteHref({ prefix: '' }, latest, 'welcome', true)).toBe('/')
    expect(siteHref({ prefix: '/pub/acme' }, v1, 'welcome', true)).toBe('/pub/acme/v1')
  })
})

describe('siteHomeId', () => {
  it('is the root page of a one-page site, else the first top-level page', () => {
    expect(siteHomeId([node('a', 'a', null, 1), node('r', ''), node('b', 'b', null, 0)])).toBe('r')
    expect(siteHomeId([node('a', 'a', null, 1), node('b', 'b', null, 0), node('c', 'b/c', 'b')])).toBe('b')
    expect(siteHomeId([])).toBeNull()
  })

  it('agrees with reading order', () => {
    const tree = [node('a', 'a', null, 1), node('b', 'b', null, 0), node('c', 'b/c', 'b')]
    expect(treeRows(tree)[0]!.documentId).toBe(siteHomeId(tree))
  })
})

describe('createSiteTree (issue #204)', () => {
  const withKids = (n: PublicSiteTreeNode, childCount: number) => ({ ...n, childCount })
  // The server's first render for page `c`: the top level, and the children of `b` (c's parent) and of `c`.
  const initial = [
    withKids(node('a', 'a', null, 0), 2),
    withKids(node('b', 'b', null, 1), 1),
    withKids(node('c', 'b/c', 'b'), 1),
    node('d', 'b/c/d', 'c'),
  ]

  it('opens the path to the current page onto the levels the server sent, and nothing else', () => {
    const tree = createSiteTree({ initial, activeId: 'c', load: async () => [] })
    expect([...tree.open].sort()).toEqual(['b', 'c'])
    expect(tree.activeDepth).toBe(1)
    expect(tree.children.get(null)?.map((n) => n.documentId)).toEqual(['a', 'b'])
    expect(tree.children.has('a')).toBe(false)
  })

  it('expanding asks for that one level once, showing it as loading meanwhile', async () => {
    const asked: string[] = []
    let release!: (nodes: PublicSiteTreeNode[]) => void
    const tree = createSiteTree({
      initial,
      activeId: 'c',
      load: (id) => {
        asked.push(id)
        return new Promise((r) => (release = r))
      },
    })
    const done = tree.toggle(initial[0]!)
    expect(tree.open.has('a')).toBe(true)
    expect(tree.loading.has('a')).toBe(true)
    release([node('a1', 'a/a1', 'a'), node('a2', 'a/a2', 'a', 1)])
    await done
    expect(tree.loading.has('a')).toBe(false)
    expect(tree.children.get('a')?.map((n) => n.documentId)).toEqual(['a1', 'a2'])

    await tree.toggle(initial[0]!) // collapse
    await tree.toggle(initial[0]!) // reopen: already here
    await tree.toggle(initial[1]!) // collapse b, sent by the server
    await tree.toggle(initial[1]!)
    expect(asked).toEqual(['a'])
  })

  it('a level that fails to load closes its branch again, and the next click retries', async () => {
    let fail = true
    const tree = createSiteTree({
      initial,
      activeId: null,
      load: async () => {
        if (fail) throw new Error('503')
        return []
      },
    })
    expect(tree.open.size).toBe(0)
    await tree.toggle(initial[0]!)
    expect(tree.open.has('a')).toBe(false)
    fail = false
    await tree.toggle(initial[0]!)
    expect(tree.open.has('a')).toBe(true)
  })
})

describe('siteThemeCss', () => {
  it('emits nothing for the default theme', () => {
    expect(siteThemeCss({ primaryColor: null, primaryColorDark: null, font: 'system', showLogo: true, headerLinks: [], footerText: null })).toBe('')
  })

  it('sets the primary for both modes, with a readable foreground', () => {
    const css = siteThemeCss({ primaryColor: '#ffdd00', primaryColorDark: '#1e3a8a', font: 'serif', showLogo: true, headerLinks: [], footerText: null })
    expect(css).toContain('html:root{--primary:#ffdd00;--primary-foreground:#0b0b0f;')
    expect(css).toContain('html.dark{--primary:#1e3a8a;--primary-foreground:#ffffff;')
    expect(css).toContain('font-family:ui-serif')
  })

  it('never lets a stored value reach the CSS as text', () => {
    const hostile = {
      primaryColor: 'red;}</style><script>alert(1)</script>',
      primaryColorDark: null,
      font: 'x;}body{display:none' as never,
      showLogo: true,
      headerLinks: [],
      footerText: null,
    }
    expect(siteThemeCss(hostile)).toBe('')
  })

  it('picks white on dark colours and near-black on light ones', () => {
    expect(foregroundFor('#000000')).toBe('#ffffff')
    expect(foregroundFor('#ffffff')).toBe('#0b0b0f')
  })
})
