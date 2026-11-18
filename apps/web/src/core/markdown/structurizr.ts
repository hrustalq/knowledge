/**
 * C4 models written in Structurizr DSL (#1244, docs/features/85). Pure: the
 * reader, the public reader, the builder and export all use it, and export
 * runs on the server.
 *
 * The subset: `person`, `softwareSystem`, `container`, `component` (nested as
 * C4 nests them), `->` relationships (with an implicit or `this` source inside
 * an element), `group` blocks, the `description` / `technology` / `tags`
 * properties, and `systemContext`, `container` and `component` views with
 * `include` / `exclude` / `autoLayout` / `title`. Anything else — styles,
 * themes, deployment, properties — is skipped, so a full Structurizr workspace
 * still draws. No `views` block means one view per level the model has.
 *
 * One addition of ours: a `// @layout id x y, id x y` comment inside a view
 * holds the positions an author dragged its elements to in the builder. It is
 * a comment, so Structurizr's own tools read past it; a view without one is
 * laid out automatically.
 *
 * Every statement keeps where it was written (`src`), which is what lets the
 * builder (./structurizr-edit) change the text rather than regenerate it.
 */

export type C4Kind = 'person' | 'softwareSystem' | 'container' | 'component'
export type C4ViewType = 'systemContext' | 'container' | 'component'

/** A statement's place in the source. Lines are 1-based; `close` is the line of its block's `}`, null with no block. */
export interface C4Span {
  line: number
  close: number | null
}

export interface C4Element {
  id: string
  kind: C4Kind
  name: string
  description: string
  technology: string
  tags: string[]
  parent: C4Element | null
  children: C4Element[]
  src: C4Span & {
    /** 0-based column of the kind keyword: what precedes it (indent, `id =`) is kept on a rewrite. */
    col: number
    /** The block's `{` is on the declaration's own line. */
    opensOnLine: boolean
    /** Nothing else shares the declaration's line, so it can be rewritten whole. */
    alone: boolean
    /** Written as `id = …`; an anonymous element has a made-up id nothing can refer to. */
    explicitId: boolean
  }
}

export interface C4Relationship {
  source: C4Element
  destination: C4Element
  description: string
  technology: string
  /** `cut`: 0-based column just after the destination, where the description begins. */
  src: { line: number; cut: number; alone: boolean }
}

export interface C4Point {
  x: number
  y: number
}

export interface C4View {
  key: string
  type: C4ViewType
  subject: C4Element
  title: string
  include: string[]
  exclude: string[]
  direction: 'TB' | 'BT' | 'LR' | 'RL'
  /** Positions by element id, from the view's `// @layout` line; null = automatic layout. */
  layout: Record<string, C4Point> | null
  /** Null for a view the model did not declare (no `views` block): see defaultViews. */
  src: (C4Span & { alone: boolean; layoutLine: number | null }) | null
}

export interface C4Model {
  elements: C4Element[]
  relationships: C4Relationship[]
  views: C4View[]
  src: { model: C4Span | null; views: C4Span | null; workspace: C4Span | null }
}

/** A problem in the author's source, in the shape the editor's mermaid status already shows. */
export class C4SyntaxError extends Error {
  /** 1-based. */
  readonly line: number | null

  constructor(message: string, line: number | null) {
    super(line ? `line ${line}: ${message}` : message)
    this.line = line
  }
}

/** The comment that carries a view's positions. */
export const LAYOUT_MARK = '@layout'

/* ------------------------------------------------------------------ lexer */

interface Token {
  /** `s` = quoted string, `w` = word, `{` `}` `->` `=`, `n` = end of statement, `L` = a `// @layout` comment. */
  t: 's' | 'w' | '{' | '}' | '->' | '=' | 'n' | 'L'
  v: string
  line: number
  /** 0-based column where the token starts. */
  col: number
  /** 0-based column just after it. */
  end: number
}

function tokenize(source: string): Token[] {
  const out: Token[] = []
  let line = 1
  let lineAt = 0
  let i = 0
  const push = (t: Token['t'], v: string, from: number) => out.push({ t, v, line, col: from - lineAt, end: i - lineAt })
  while (i < source.length) {
    const c = source[i]
    const from = i
    // A `#` comment only opens a line; mid-line it is part of a word.
    const lineStart = out.length === 0 || out[out.length - 1].t === 'n'
    if (c === '\n') {
      i++
      push('n', '', from)
      line++
      lineAt = i
    } else if (c === ' ' || c === '\t' || c === '\r') {
      i++
    } else if (source.startsWith('//', i) || (c === '#' && lineStart)) {
      while (i < source.length && source[i] !== '\n') i++
      const text = source.slice(from, i).replace(/^(\/\/|#)\s*/, '')
      if (text.startsWith(LAYOUT_MARK)) push('L', text.slice(LAYOUT_MARK.length).trim(), from)
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      for (let k = i; k < stop; k++) {
        if (source[k] === '\n') {
          line++
          lineAt = k + 1
        }
      }
      i = stop
    } else if (c === '"') {
      let v = ''
      i++
      while (i < source.length && source[i] !== '"' && source[i] !== '\n') {
        if (source[i] === '\\' && i + 1 < source.length && source[i + 1] !== '\n') i++
        v += source[i++]
      }
      if (source[i] !== '"') throw new C4SyntaxError('unterminated string', line)
      i++
      push('s', v, from)
    } else if (c === '{' || c === '}' || c === '=') {
      i++
      push(c, '', from)
    } else if (source.startsWith('->', i)) {
      i += 2
      push('->', '', from)
    } else {
      const m = /^[^\s{}="]+/.exec(source.slice(i))!
      // `a->b` with no spaces: stop the word at the arrow.
      const word = m[0].split('->')[0] || m[0]
      i += word.length
      push('w', word, from)
    }
  }
  push('n', '', i)
  return out
}

/** `user 120 40, shop 300 200` → positions; anything malformed is dropped, not an error. */
function parseLayout(text: string): Record<string, C4Point> {
  const layout: Record<string, C4Point> = {}
  for (const entry of text.split(',')) {
    const [id, x, y] = entry.trim().split(/\s+/)
    if (id && Number.isFinite(Number(x)) && Number.isFinite(Number(y))) layout[id] = { x: Number(x), y: Number(y) }
  }
  return layout
}

/* ----------------------------------------------------------------- parser */

const NESTS: Record<C4Kind, C4Kind | null> = {
  person: null,
  softwareSystem: null,
  container: 'softwareSystem',
  component: 'container',
}
const KINDS = new Set(Object.keys(NESTS))
const VIEW_TYPES = new Set<string>(['systemContext', 'container', 'component'])

export function parseStructurizr(source: string): C4Model {
  const tokens = tokenize(source)
  let p = 0
  const peek = () => tokens[p]
  const next = () => tokens[p++]
  const fail = (message: string, at = peek()): never => {
    throw new C4SyntaxError(message, at?.line ?? null)
  }
  const skipBlanks = () => {
    while (peek()?.t === 'n') p++
  }
  /** The words and strings up to the end of a statement or the `{` that opens its block. */
  const args = () => {
    const out: Token[] = []
    while (peek() && peek().t !== 'n' && peek().t !== '{' && peek().t !== '}') out.push(next())
    return out
  }
  /** Skip a `{ … }` block, nested ones included, if one starts here. */
  const skipBlock = () => {
    if (peek()?.t !== '{') return
    let depth = 0
    do {
      const tok = next() ?? fail('missing }')
      if (tok.t === '{') depth++
      else if (tok.t === '}') depth--
    } while (depth > 0)
  }
  const strings = (list: Token[]) => list.filter((tok) => tok.t === 's').map((tok) => tok.v)
  /** The statement starting at token `start` begins its line. */
  const startsLine = (start: number) => start === 0 || tokens[start - 1].t === 'n'
  /** What is left of the statement here ends its line, an opening `{` aside. */
  const endsLine = () => peek()?.t === 'n' || (peek()?.t === '{' && tokens[p + 1]?.t === 'n')

  const elements: C4Element[] = []
  const byId = new Map<string, C4Element>()
  const pending: Array<{ from: string | C4Element; to: string; args: string[]; line: number; src: C4Relationship['src'] }> = []
  type ViewDef = Omit<C4View, 'subject' | 'title'> & { subject: string; title: string | null; line: number }
  const viewDefs: ViewDef[] = []
  const spans: C4Model['src'] = { model: null, views: null, workspace: null }

  /** `{ body }`; returns the line of its `}`. */
  function block(body: () => void): number {
    if (peek()?.t !== '{') fail('expected {')
    next()
    for (;;) {
      skipBlanks()
      const tok = peek() ?? fail('missing }')
      if (tok.t === '}') {
        next()
        return tok.line
      }
      body()
    }
  }

  function model(parent: C4Element | null) {
    const start = p
    const head = peek()
    // [id =] kind "name" …
    let id: string | null = null
    if (head.t === 'w' && tokens[p + 1]?.t === '=') {
      id = head.v
      p += 2
    }
    const tok = peek()
    if (tok.t === '->' || (tok.t === 'w' && tokens[p + 1]?.t === '->')) {
      const from: string | C4Element =
        tok.t === '->' || tok.v === 'this' ? (parent ?? fail('a relationship needs a source', tok)) : tok.v
      if (tok.t === 'w') p++
      next()
      const to = next()
      if (to?.t !== 'w') fail('expected a relationship destination', to)
      const rest = args()
      pending.push({
        from,
        to: to.v,
        args: strings(rest),
        line: tok.line,
        src: { line: to.line, cut: to.end, alone: startsLine(start) && peek()?.t === 'n' },
      })
      skipBlock()
      return
    }
    if (tok.t === 'w' && KINDS.has(tok.v)) {
      next()
      const kind = tok.v as C4Kind
      if (NESTS[kind] !== (parent?.kind ?? null)) {
        fail(NESTS[kind] ? `${kind} belongs inside a ${NESTS[kind]}` : `${kind} belongs at the top of the model`, tok)
      }
      const [name = '', description = '', ...rest] = strings(args())
      const hasTech = kind === 'container' || kind === 'component'
      const opensOnLine = peek()?.t === '{'
      const el: C4Element = {
        id: id ?? `${kind}-${elements.length}`,
        kind,
        name,
        description,
        technology: hasTech ? (rest[0] ?? '') : '',
        tags: splitTags(hasTech ? rest[1] : rest[0]),
        parent,
        children: [],
        src: { line: tok.line, close: null, col: tok.col, opensOnLine, alone: startsLine(start) && endsLine(), explicitId: !!id },
      }
      if (!name) fail(`${kind} needs a name`, tok)
      elements.push(el)
      parent?.children.push(el)
      if (id) byId.set(id, el)
      if (id && parent) byId.set(`${pathOf(parent)}.${id}`, el)
      if (opensOnLine) el.src.close = block(() => model(el))
      return
    }
    if (tok.t === 'w' && parent && (tok.v === 'description' || tok.v === 'technology' || tok.v === 'tags' || tok.v === 'tag')) {
      next()
      const value = strings(args())
      if (tok.v === 'description') parent.description = value[0] ?? ''
      else if (tok.v === 'technology') parent.technology = value[0] ?? ''
      else parent.tags.push(...value.flatMap(splitTags))
      return
    }
    if (tok.t === 'w' && tok.v === 'group') {
      args()
      block(() => model(parent))
      return
    }
    // Anything else (enterprise, deploymentEnvironment, properties, !impliedRelationships…): skipped whole.
    args()
    skipBlock()
  }

  function pathOf(el: C4Element): string {
    const ids: string[] = []
    for (let at: C4Element | null = el; at; at = at.parent) ids.unshift(at.id)
    return ids.join('.')
  }

  function views() {
    const start = p
    const tok = next()
    if (tok.t === 'w' && VIEW_TYPES.has(tok.v)) {
      const [subject, ...rest] = args()
      if (subject?.t !== 'w') fail(`${tok.v} needs the element it shows`, tok)
      const keyed = rest.filter((r) => r.t === 's' || r.t === 'w').map((r) => r.v)
      const def: ViewDef = {
        key: keyed[0] ?? `${tok.v}-${viewDefs.length}`,
        type: tok.v as C4ViewType,
        subject: subject.v,
        title: null,
        include: [],
        exclude: [],
        direction: 'TB',
        layout: null,
        src: { line: tok.line, close: null, alone: startsLine(start) && endsLine(), layoutLine: null },
        line: tok.line,
      }
      if (peek()?.t === '{') {
        def.src!.close = block(() => {
          // A layout comment is a statement of its own here; skipBlanks steps over it everywhere else.
          if (peek().t === 'L') {
            const mark = next()
            def.layout = parseLayout(mark.v)
            def.src!.layoutLine = mark.line
            return
          }
          const stmt = next()
          const values = args().map((v) => v.v)
          skipBlock()
          if (stmt.t !== 'w') return
          const word = stmt.v.toLowerCase()
          if (word === 'include') def.include.push(...values)
          else if (word === 'exclude') def.exclude.push(...values)
          else if (word === 'title') def.title = values[0] ?? null
          else if (word === 'autolayout') def.direction = layoutDirection(values[0])
        })
      }
      viewDefs.push(def)
      return
    }
    args()
    skipBlock()
  }

  // `workspace "name" { … }`, or the model and views written bare.
  const top = () => {
    const tok = next()
    if (tok.t === 'w' && tok.v === 'model') spans.model = { line: tok.line, close: block(() => model(null)) }
    else if (tok.t === 'w' && tok.v === 'views') spans.views = { line: tok.line, close: block(views) }
    else {
      args()
      skipBlock()
    }
  }
  // A layout comment in a view is read inside it; anywhere else it is only a comment.
  const blanksAndStrayLayout = () => {
    while (peek()?.t === 'n' || peek()?.t === 'L') p++
  }
  blanksAndStrayLayout()
  if (peek()?.t === 'w' && peek().v === 'workspace') {
    const ws = next()
    args()
    spans.workspace = { line: ws.line, close: block(top) }
  } else {
    while ((blanksAndStrayLayout(), p < tokens.length)) top()
  }

  const find = (ref: string, line: number) => byId.get(ref) ?? fail(`no element called "${ref}"`, { t: 'w', v: ref, line, col: 0, end: 0 })
  const relationships: C4Relationship[] = pending.map(({ from, to, args: [description = '', technology = ''], line, src }) => ({
    source: typeof from === 'string' ? find(from, line) : from,
    destination: find(to, line),
    description,
    technology,
    src,
  }))

  const views_: C4View[] = viewDefs.map(({ line, ...def }) => {
    const subject = find(def.subject, line)
    const wants: C4Kind = def.type === 'systemContext' || def.type === 'container' ? 'softwareSystem' : 'container'
    if (subject.kind !== wants) fail(`a ${def.type} view shows a ${wants}, and "${def.subject}" is a ${subject.kind}`, { t: 'w', v: '', line, col: 0, end: 0 })
    return { ...def, subject, title: def.title ?? '' }
  })

  const model_: C4Model = { elements, relationships, views: views_, src: spans }
  if (model_.views.length === 0) model_.views = defaultViews(model_)
  if (model_.views.length === 0) throw new C4SyntaxError('the model has no software system to show', null)
  return model_
}

function splitTags(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

function layoutDirection(value: string | undefined): C4View['direction'] {
  const v = (value ?? '').toUpperCase()
  return v === 'LR' || v === 'RL' || v === 'BT' ? v : 'TB'
}

/** One view per level the model has, top-level systems first. They are not in the source (`src: null`). */
function defaultViews(model: Pick<C4Model, 'elements'>): C4View[] {
  const views: C4View[] = []
  const view = (type: C4ViewType, subject: C4Element) =>
    views.push({ key: `${type}-${subject.id}`, type, subject, title: '', include: [], exclude: [], direction: 'TB', layout: null, src: null })
  for (const system of model.elements.filter((e) => e.kind === 'softwareSystem')) {
    view('systemContext', system)
    if (system.children.length) view('container', system)
  }
  for (const container of model.elements.filter((e) => e.kind === 'container' && e.children.length)) view('component', container)
  return views
}

/* ------------------------------------------------------------------ views */

/** The view a click on `element` zooms into: its containers, or its components. */
export function detailViewOf(model: C4Model, element: C4Element): C4View | undefined {
  return model.views.find(
    (v) => v.subject === element && (v.type === 'container' || v.type === 'component'),
  )
}

/**
 * What a view shows, as Structurizr's `include *` means it: the view's own
 * elements, plus whatever is directly connected to them, lifted to the level
 * the view draws (a component of another system is drawn as that system).
 */
export function viewElements(model: C4Model, view: C4View): { nodes: C4Element[]; boundary: C4Element | null } {
  const { subject } = view
  const scope = view.type === 'systemContext' ? [] : view.type === 'container' ? [subject] : [subject.parent!, subject]
  const inner = new Set(view.type === 'systemContext' ? [subject] : subject.children)
  const lift = (el: C4Element): C4Element | null => {
    const chain = lineage(el)
    let k = 0
    while (k < scope.length && chain[k] === scope[k]) k++
    return chain[k] ?? null
  }

  const star = new Set(inner)
  for (const r of model.relationships) {
    const a = lift(r.source)
    const b = lift(r.destination)
    if (!a || !b || a === b) continue
    if (inner.has(a)) star.add(b)
    if (inner.has(b)) star.add(a)
  }

  const byId = new Map(model.elements.map((e) => [e.id, e]))
  const nodes = new Set<C4Element>()
  const include = view.include.length ? view.include : ['*']
  for (const ref of include) {
    if (ref === '*') star.forEach((e) => nodes.add(e))
    else if (byId.has(ref)) nodes.add(byId.get(ref)!)
  }
  for (const ref of view.exclude) nodes.delete(byId.get(ref)!)
  return { nodes: [...nodes], boundary: view.type === 'systemContext' ? null : subject }
}

/** Top-down: the element's top-level ancestor first, the element last. */
export function lineage(el: C4Element): C4Element[] {
  const chain: C4Element[] = []
  for (let at: C4Element | null = el; at; at = at.parent) chain.unshift(at)
  return chain
}

/* ---------------------------------------------------------------- mermaid */

export const KIND_LABEL: Record<C4Kind, string> = {
  person: 'Person',
  softwareSystem: 'Software System',
  container: 'Container',
  component: 'Component',
}

/** The style an element is drawn in: its kind, or grey for anything out of the view's scope. */
export type C4Style = C4Kind | 'external'

/**
 * Structurizr's default C4 palette, which is what a reader who knows C4
 * expects; external systems are grey. Hex, not oklch: mermaid parses these.
 * Both renderers (mermaid here, ./c4-svg for laid-out views) draw from it.
 */
export const C4_PALETTE: Record<C4Style, { fill: string; stroke: string; text: string }> = {
  person: { fill: '#08427b', stroke: '#052e56', text: '#ffffff' },
  softwareSystem: { fill: '#1168bd', stroke: '#0b4884', text: '#ffffff' },
  external: { fill: '#8a8a8a', stroke: '#6b6b6b', text: '#ffffff' },
  container: { fill: '#438dd5', stroke: '#2e6295', text: '#ffffff' },
  component: { fill: '#85bbf0', stroke: '#5d82a8', text: '#0b2540' },
}

export function styleOf(el: C4Element, view: C4View): C4Style {
  // Any system other than the one the view is about is drawn grey, as C4 draws systems out of scope.
  const external = el.tags.some((t) => t.toLowerCase() === 'external') || (el.kind === 'softwareSystem' && el !== view.subject)
  return external ? 'external' : el.kind
}

export const isDatabase = (el: C4Element) => el.tags.some((t) => t.toLowerCase() === 'database')

/** `[Container: NestJS]`: what an element is, under its name. */
export function kindLine(el: C4Element): string {
  return el.technology && (el.kind === 'container' || el.kind === 'component')
    ? `[${KIND_LABEL[el.kind]}: ${el.technology}]`
    : `[${KIND_LABEL[el.kind]}]`
}

/**
 * The relationships a view draws, each lifted to the nearest element the view
 * shows and drawn once per pair; `index` is the first model relationship behind it.
 */
export function viewRelationships(model: C4Model, nodes: C4Element[]): Array<{ from: C4Element; to: C4Element; rel: C4Relationship; index: number }> {
  const shown = new Set(nodes)
  const rep = (el: C4Element) => lineage(el).reverse().find((e) => shown.has(e))
  const seen = new Set<string>()
  const out: Array<{ from: C4Element; to: C4Element; rel: C4Relationship; index: number }> = []
  model.relationships.forEach((rel, index) => {
    const from = rep(rel.source)
    const to = rep(rel.destination)
    if (!from || !to || from === to) return
    const key = `${nodes.indexOf(from)}>${nodes.indexOf(to)}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ from, to, rel, index })
  })
  return out
}

/** Mermaid node id of the i-th node; the rendered SVG's `<g id>` carries it (`…-flowchart-c4n3-3`). */
export const C4_NODE_PREFIX = 'c4n'

/**
 * One view as Mermaid flowchart source. `nodes[i]` is drawn as
 * `${C4_NODE_PREFIX}${i}`, which is how a click on the drawing finds its element.
 */
export function viewToMermaid(model: C4Model, view: C4View): { source: string; nodes: C4Element[] } {
  const { nodes, boundary } = viewElements(model, view)
  const index = new Map(nodes.map((n, i) => [n, `${C4_NODE_PREFIX}${i}`]))
  const inside = (el: C4Element) => !!boundary && el.parent === boundary

  const lines = [
    `flowchart ${view.direction}`,
    ...Object.entries(C4_PALETTE).map(([name, c]) => `  classDef ${name} fill:${c.fill},stroke:${c.stroke},color:${c.text}`),
  ]
  const node = (el: C4Element) => {
    const text = [label(el.name), label(kindLine(el)), ...wrap(el.description, 34).map(label)].join('<br/>')
    const [open, close] = el.kind === 'person' ? ['([', '])'] : isDatabase(el) ? ['[(', ')]'] : ['(', ')']
    return `${index.get(el)}${open}"${text}"${close}`
  }

  if (boundary) {
    // One line: a two-line cluster title overlaps the first node inside it.
    lines.push(`  subgraph c4b ["${label(`${boundary.name} [${KIND_LABEL[boundary.kind]}]`)}"]`)
    for (const el of nodes.filter(inside)) lines.push(`    ${node(el)}`)
    lines.push('  end', '  style c4b fill:none,stroke:#8a8a8a,stroke-dasharray:6 4')
  }
  for (const el of nodes.filter((n) => !inside(n))) lines.push(`  ${node(el)}`)

  for (const { from, to, rel } of viewRelationships(model, nodes)) {
    const text = [...wrap(rel.description, 28).map(label), ...(rel.technology ? [label(`[${rel.technology}]`)] : [])].join('<br/>')
    lines.push(text ? `  ${index.get(from)} -->|"${text}"| ${index.get(to)}` : `  ${index.get(from)} --> ${index.get(to)}`)
  }

  for (const el of nodes) lines.push(`  class ${index.get(el)} ${styleOf(el, view)}`)
  return { source: lines.join('\n'), nodes }
}

/**
 * Page text inside a mermaid label. Every label is a quoted string, so the
 * only way out of one is `"`; `<` and `>` would read as markup next to the
 * `<br/>` this joins lines with. Each becomes a look-alike, not an entity:
 * mermaid decodes `#…;` in node labels only, and an edge label or a boundary
 * title would show it raw.
 */
function label(text: string): string {
  return text.replace(/"/g, "'").replace(/</g, '‹').replace(/>/g, '›')
}

/** Word wrap for SVG text, which does not wrap by itself. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(current)
      current = word
    } else current = current ? `${current} ${word}` : word
  }
  if (current) lines.push(current)
  return lines
}

/** The title a view goes by: the author's, else the subject and the level. */
export function viewTitle(view: C4View, levelLabel: (type: C4ViewType) => string): string {
  return view.title || `${view.subject.name} · ${levelLabel(view.type)}`
}

export { C4_LANG } from './c4-lang'
