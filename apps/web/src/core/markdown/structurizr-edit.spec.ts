import { describe, expect, it } from 'vitest'
import { parseStructurizr, viewElements } from './structurizr'
import {
  C4EditError,
  addDetailView,
  addElement,
  clearLayout,
  connectElements,
  deleteElement,
  deleteRelationship,
  placeElements,
  starterModel,
  updateElement,
  updateRelationship,
  withIds,
} from './structurizr-edit'

// The builder edits the author's text, never regenerates it (#1244): whatever
// it does not touch — comments, styles, formatting — must come out as it went in.
const SHOP = `workspace "Shop" {
  model {
    // people first
    user = person "Customer" "Buys things"
    shop = softwareSystem "Shop" {
      web = container "Web" "Storefront" "Vue"
      api = container "API" "Orders" "NestJS" {
        -> web "Pushes updates"
      }
    }
    user -> web "Shops"
  }
  views {
    systemContext shop "context" {
      include *
    }
    container shop "containers" {
      include *
    }
    styles {
      element "Person" { shape Person }
    }
  }
}`

const view = (source: string, key: string) => parseStructurizr(source).views.findIndex((v) => v.key === key)
const shownIds = (source: string, index: number) => {
  const model = parseStructurizr(source)
  return viewElements(model, model.views[index]).nodes.map((n) => n.id)
}
const shown = (source: string, key: string) => {
  const model = parseStructurizr(source)
  return viewElements(model, model.views.find((v) => v.key === key)!).nodes.map((n) => n.id)
}

describe('structurizr-edit', () => {
  it('names anonymous elements once, from their names, and says what it renamed', () => {
    const { source, renamed } = withIds('model {\n  person "Ada Lovelace"\n  softwareSystem "Платёжный шлюз"\n}')
    expect(source).toContain('adaLovelace = person "Ada Lovelace"')
    expect(source).toContain('system = softwareSystem "Платёжный шлюз"')
    expect([...renamed.values()]).toEqual(['system', 'adaLovelace'])
    expect(withIds(source).renamed.size).toBe(0)
  })

  it('adds a container inside the system a container view shows, placed where it was dropped', () => {
    const { source, id } = addElement(SHOP, view(SHOP, 'containers'), 'container', 'Payment API', { web: { x: 0, y: 0 } }, { x: 400, y: 160 })
    expect(id).toBe('paymentApi')
    expect(source).toMatch(/\n {6}paymentApi = container "Payment API"\n {4}}/)
    const containers = parseStructurizr(source).views.find((v) => v.key === 'containers')!
    expect(containers.layout).toMatchObject({ web: { x: 0, y: 0 }, paymentApi: { x: 400, y: 160 } })
    expect(source).toContain('    // people first')
    expect(source).toContain('element "Person" { shape Person }')
  })

  it('includes by name what a view would not show by itself', () => {
    const { source } = addElement(SHOP, view(SHOP, 'context'), 'person', 'Auditor', {}, { x: 0, y: 300 })
    expect(shown(source, 'context')).toContain('auditor')
    expect(source).toContain('      include auditor')
  })

  it('writes out the views a model was showing by default before changing one', () => {
    const bare = 'workspace {\n  model {\n    s = softwareSystem "S" {\n      a = container "A"\n    }\n  }\n}'
    const out = placeElements(bare, 1, { a: { x: 10, y: 20 } })
    expect(out).toContain('    container s "container-s" {')
    expect(parseStructurizr(out).views[1].layout).toEqual({ a: { x: 10, y: 20 } })
    expect(parseStructurizr(out).views.map((v) => v.key)).toEqual(['systemContext-s', 'container-s'])
  })

  it('connects two elements at the end of the model, and edits what the link says', () => {
    const linked = connectElements(SHOP, 'api', 'user')
    const model = parseStructurizr(linked)
    const last = model.relationships.length - 1
    expect(model.relationships[last]).toMatchObject({ source: { id: 'api' }, destination: { id: 'user' } })
    const said = updateRelationship(linked, last, { description: 'Emails "receipts"', technology: 'SMTP' })
    expect(said).toContain('    api -> user "Emails \\"receipts\\"" "SMTP"')
    expect(parseStructurizr(said).relationships[last].description).toBe('Emails "receipts"')
  })

  it('rewrites a declaration but keeps its id and its block, and an implicit source keeps its form', () => {
    const out = updateElement(SHOP, 'api', { name: 'Orders API', technology: 'Go', database: true })
    expect(out).toContain('      api = container "Orders API" "Orders" "Go" "Database" {')
    const pushes = parseStructurizr(SHOP).relationships.findIndex((r) => r.description === 'Pushes updates')
    expect(updateRelationship(SHOP, pushes, { description: 'Notifies' })).toContain('        -> web "Notifies"')
  })

  it('deletes an element with what is inside it, every link to it and the views about it', () => {
    const out = deleteElement(SHOP, 'shop')
    expect(out).not.toMatch(/container|-> web|"context"/)
    expect(() => parseStructurizr(out)).toThrow(/no software system/)
    const noApi = deleteElement(SHOP, 'api')
    expect(noApi).not.toContain('Pushes updates')
    expect(parseStructurizr(noApi).relationships).toHaveLength(1)
    expect(parseStructurizr(deleteRelationship(SHOP, 1)).relationships).toHaveLength(1)
  })

  it('opens the next level down by declaring its view', () => {
    const { source, viewIndex } = addDetailView(SHOP, 'api')
    expect(source).toContain('    component api "component-api" {')
    expect(parseStructurizr(source).views[viewIndex]).toMatchObject({ type: 'component', subject: { id: 'api' } })
    expect(addDetailView(SHOP, 'shop').viewIndex).toBe(view(SHOP, 'containers'))
  })

  it('puts a view back on automatic layout', () => {
    const placed = placeElements(SHOP, 0, { user: { x: 1, y: 2 } })
    expect(parseStructurizr(placed).views[0].layout).not.toBeNull()
    expect(parseStructurizr(clearLayout(placed, 0)).views[0].layout).toBeNull()
  })

  it('opens a view written on one line before writing into it', () => {
    const oneLine = 'model {\n  u = person "U"\n  s = softwareSystem "S"\n  u -> s\n}\nviews {\n  systemContext s { include * }\n}'
    const { source } = addElement(oneLine, 0, 'person', 'Admin', {}, { x: 0, y: 0 })
    expect(source).toContain('  systemContext s {\n    include *\n    include admin\n    // @layout')
    expect(shownIds(source, 0)).toContain('admin')
  })

  it('refuses what it cannot change without risking the text', () => {
    const packed = 'model {\n  s = softwareSystem "S"\n  a = person "A" { -> s }\n}'
    expect(() => updateElement(packed, 'a', { name: 'X' })).toThrow(C4EditError)
  })

  it('starts from a model that draws', () => {
    const model = parseStructurizr(starterModel({ user: 'User', system: 'System', uses: 'Uses' }))
    expect(model.views).toHaveLength(1)
    expect(model.relationships).toHaveLength(1)
  })
})
