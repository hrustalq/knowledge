import { describe, expect, it } from 'vitest'
import type { PublicSiteTreeNode } from '@knowledge/contracts'
import { siteHomeId, siteHref, treeRows } from './reader-state'
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
