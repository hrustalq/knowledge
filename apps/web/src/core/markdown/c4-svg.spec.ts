// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import DOMPurify from 'dompurify'
import { autoLayout, positionsOf, renderC4Svg } from './c4-svg'
import { parseStructurizr } from './structurizr'

const SOURCE = `model {
  user = person "Customer <b>" "Buys"
  shop = softwareSystem "Shop" {
    web = container "Web"
    db = container "DB" "" "" "Database"
    web -> db "Writes"
  }
  user -> web "Shops"
}
views {
  container shop {
    include *
    // @layout user 0 0, web 0 300
  }
}`

describe('renderC4Svg', () => {
  const model = parseStructurizr(SOURCE)
  const view = model.views[0]

  it('places what the layout names, and the rest in a row below', () => {
    const at = positionsOf(model, view)
    const byId = Object.fromEntries([...at].map(([el, p]) => [el.id, p]))
    expect(byId.user).toEqual({ x: 0, y: 0 })
    expect(byId.web).toEqual({ x: 0, y: 300 })
    expect(byId.db.y).toBeGreaterThan(300)
  })

  it('lays out top-down when there is no layout', () => {
    const at = autoLayout(model, { ...view, layout: null })
    const y = Object.fromEntries([...at].map(([el, p]) => [el.id, p.y]))
    expect(y.user).toBeLessThan(y.web)
    expect(y.web).toBeLessThan(y.db)
  })

  it('draws elements and links the builder can find after sanitizing, with page text escaped', () => {
    const { svg, nodes } = renderC4Svg(model, view, positionsOf(model, view), { handles: true, selectedNode: model.elements[0] })
    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    const host = document.createElement('div')
    host.innerHTML = clean
    expect(host.querySelectorAll('[data-c4-node]')).toHaveLength(nodes.length)
    expect(host.querySelectorAll('[data-c4-rel]')).toHaveLength(2)
    expect(host.querySelectorAll('[data-c4-handle]')).toHaveLength(nodes.length)
    expect(host.querySelector('[data-selected]')?.getAttribute('data-c4-node')).toBe(String(nodes.indexOf(model.elements[0])))
    expect(host.querySelector('b')).toBeNull()
    expect(host.textContent).toContain('Customer <b>')
    expect(host.querySelector('.kn-c4-boundary')?.textContent).toBe('Shop [Software System]')
  })
})
