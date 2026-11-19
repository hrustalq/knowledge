import { describe, expect, it } from 'vitest'
import { C4SyntaxError, detailViewOf, parseStructurizr, viewElements, viewToMermaid } from './structurizr'

const WORKSPACE = `workspace "Knowledge" {
  !identifiers flat
  model {
    reader = person "Reader" "Reads and searches pages"
    mail = softwareSystem "Mail relay" "Sends email" "External"
    kn = softwareSystem "Knowledge" "Versioned docs" {
      web = container "Web" "Vue SSR app" "Vue 3"
      api = container "API" "REST and MCP" "NestJS" {
        search = component "SearchService" "Hybrid search over chunks"
        docs = component "DocumentsService"
        search -> docs "Loads pages"
      }
      db = container "Database" "Transactional truth" "PostgreSQL" "Database"
      # a comment
      web -> api "Calls" "REST"
      docs -> db "Reads and writes" // trailing comment
      api -> mail "Sends mail"
    }
    reader -> web "Reads pages"
  }
  views {
    systemContext kn "context" {
      include *
      autoLayout lr
    }
    container kn "containers" { include * }
    component api "components" {
      include *
      title "Inside the API"
    }
    styles { element "Person" { shape Person } }
  }
}`

describe('parseStructurizr', () => {
  const model = parseStructurizr(WORKSPACE)
  const view = (key: string) => model.views.find((v) => v.key === key)!
  const names = (key: string) => viewElements(model, view(key)).nodes.map((n) => n.name).sort()

  it('nests elements and reads their arguments', () => {
    const api = model.elements.find((e) => e.id === 'api')!
    expect(api).toMatchObject({ kind: 'container', name: 'API', description: 'REST and MCP', technology: 'NestJS' })
    expect(api.parent?.id).toBe('kn')
    expect(api.children.map((c) => c.id)).toEqual(['search', 'docs'])
    expect(model.elements.find((e) => e.id === 'db')!.tags).toEqual(['Database'])
    expect(model.relationships).toHaveLength(5)
  })

  it('include * lifts each relationship to the level the view draws', () => {
    expect(names('context')).toEqual(['Knowledge', 'Mail relay', 'Reader'])
    expect(names('containers')).toEqual(['API', 'Database', 'Mail relay', 'Reader', 'Web'])
    // web -> api and api -> mail name the container, not a component: Structurizr leaves them out too.
    expect(names('components')).toEqual(['Database', 'DocumentsService', 'SearchService'])
    expect(view('context').direction).toBe('LR')
    expect(view('components').title).toBe('Inside the API')
  })

  it('links each element to the view that zooms into it', () => {
    const kn = model.elements.find((e) => e.id === 'kn')!
    const api = model.elements.find((e) => e.id === 'api')!
    expect(detailViewOf(model, kn)?.key).toBe('containers')
    expect(detailViewOf(model, api)?.key).toBe('components')
    expect(detailViewOf(model, model.elements.find((e) => e.id === 'web')!)).toBeUndefined()
  })

  it('draws a view as a flowchart whose node ids index its elements', () => {
    const { source, nodes } = viewToMermaid(model, view('containers'))
    expect(source).toMatch(/^flowchart TB/)
    expect(source).toContain('subgraph c4b')
    const at = (name: string) => `c4n${nodes.findIndex((n) => n.name === name)}`
    expect(source).toContain(`${at('Web')} -->|"Calls<br/>[REST]"| ${at('API')}`)
    expect(source).toContain(`${at('Database')}[(`)
    expect(source).toContain(`class ${at('Mail relay')} external`)
  })

  it('keeps page text inside its quoted label', () => {
    const own = parseStructurizr('model {\n s = softwareSystem "A \\"q\\" <b>" "d\\"]\\n click s call alert(1)"\n}')
    const text = viewToMermaid(own, own.views[0]).source
    expect(text).not.toMatch(/<b>|"q"|d"\]/)
    expect(text).toContain("A 'q' ‹b›")
    // Each node line opens one quoted label and closes it: nothing after it is mermaid syntax.
    expect(text.split('\n').find((l) => l.includes('A \'q\''))).toMatch(/^\s*c4n0\("[^"]*"\)$/)
  })

  it('makes one view per level when the workspace declares none', () => {
    const bare = parseStructurizr('model {\n s = softwareSystem "S" {\n c = container "C" {\n x = component "X"\n }\n }\n}')
    expect(bare.views.map((v) => v.type)).toEqual(['systemContext', 'container', 'component'])
  })

  it.each([
    ['model {\n  c = container "C"\n}', 2, /belongs inside a softwareSystem/],
    ['model {\n  a = person "A"\n  a -> nobody\n}', 3, /no element called "nobody"/],
    ['model {\n  a = person "A\n}', 2, /unterminated string/],
    ['model {\n s = softwareSystem "S"\n}\nviews {\n  component s\n}', 5, /component view shows a container/],
  ])('reports %j at line %i', (source, line, message) => {
    let error: unknown
    try {
      parseStructurizr(source)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(C4SyntaxError)
    expect((error as C4SyntaxError).line).toBe(line)
    expect((error as Error).message).toMatch(message)
  })
})
