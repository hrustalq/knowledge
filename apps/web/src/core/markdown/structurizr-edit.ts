/**
 * What the C4 builder does to a model's text (#1244, docs/features/85). The
 * source stays canonical: every operation edits the Structurizr DSL in place,
 * by the line and column the parser recorded, so an author's formatting,
 * comments and the parts this app does not read (styles, deployment…) survive
 * a visual edit. Pure, and each one returns the new source.
 *
 * What it cannot change safely — a statement sharing its line with another, a
 * block closed on the same line as its content — it refuses with a
 * C4EditError rather than guess; the author edits that one in Source.
 *
 * Elements and views are named the way the builder holds them across edits:
 * an element by its id (`withIds` first gives every anonymous element one, so
 * an id never changes under an edit), a view by its index (an edit only ever
 * appends one).
 */
import { positionsOf } from './c4-svg'
import {
  LAYOUT_MARK,
  parseStructurizr,
  viewElements,
  type C4Element,
  type C4Kind,
  type C4Model,
  type C4Point,
  type C4View,
  type C4ViewType,
} from './structurizr'

/** The builder cannot make this change without risking the text; the message says why. */
export class C4EditError extends Error {}

const split = (source: string) => source.split('\n')
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0]
const deeper = (indent: string) => `${indent}  `
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function refuse(message: string): never {
  throw new C4EditError(message)
}

/** The 0-based index of a closing line that holds only `}`, where new lines go before it. */
function closeAt(lines: string[], close: number | null): number {
  if (close === null || lines[close - 1]?.trim() !== '}') refuse('a block here is closed on a line shared with other text')
  return close - 1
}

function element(model: C4Model, id: string): C4Element {
  return model.elements.find((e) => e.id === id) ?? refuse(`no element called "${id}"`)
}

function view(model: C4Model, index: number): C4View {
  return model.views[index] ?? refuse('that view is gone')
}

/** `kind "name" "description" ["technology"] ["tags"]`, trailing empties dropped. */
function declaration(el: Pick<C4Element, 'kind' | 'name' | 'description' | 'technology' | 'tags'>): string {
  const technical = el.kind === 'container' || el.kind === 'component'
  const args = [el.name, el.description, ...(technical ? [el.technology] : []), el.tags.join(',')]
  while (args.length > 1 && !args[args.length - 1]) args.pop()
  return `${el.kind} ${args.map(quote).join(' ')}`
}

/** An id from the name (`Payment API` → `paymentApi`), else from the kind; never one already taken. */
function newId(taken: Set<string>, name: string, kind: C4Kind): string {
  const words = name.normalize('NFKD').replace(/[^A-Za-z0-9\s_-]/g, '').split(/[\s_-]+/).filter(Boolean)
  let base = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')
  if (!/^[A-Za-z]/.test(base)) base = kind === 'softwareSystem' ? 'system' : kind
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`
  taken.add(id)
  return id
}

/**
 * Every element gets an `id = ` the text can refer to. Run before any other
 * edit; `renamed` maps the made-up ids the parser gave anonymous elements to
 * the ones now written.
 */
export function withIds(source: string): { source: string; renamed: Map<string, string> } {
  const model = parseStructurizr(source)
  const renamed = new Map<string, string>()
  const anonymous = model.elements.filter((e) => !e.src.explicitId)
  if (!anonymous.length) return { source, renamed }
  const lines = split(source)
  const taken = new Set(model.elements.filter((e) => e.src.explicitId).map((e) => e.id))
  // Right to left within a line, so an insertion never moves a column still to come.
  for (const el of [...anonymous].sort((a, b) => b.src.line - a.src.line || b.src.col - a.src.col)) {
    const id = newId(taken, el.name, el.kind)
    renamed.set(el.id, id)
    const i = el.src.line - 1
    lines[i] = `${lines[i].slice(0, el.src.col)}${id} = ${lines[i].slice(el.src.col)}`
  }
  return { source: lines.join('\n'), renamed }
}

/** A `views` block holding the views the model was showing by default, so one can be changed. */
function materializeViews(source: string): string {
  const model = parseStructurizr(source)
  if (model.src.views) return source
  const lines = split(source)
  const at = model.src.model ?? refuse('the model has no model block')
  const indent = indentOf(lines[at.line - 1])
  const block = [
    `${indent}views {`,
    ...model.views.flatMap((v) => [
      `${deeper(indent)}${v.type} ${v.subject.id} ${quote(v.key)} {`,
      `${deeper(deeper(indent))}include *`,
      `${deeper(indent)}}`,
    ]),
    `${indent}}`,
  ]
  if (model.src.workspace) lines.splice(closeAt(lines, model.src.workspace.close), 0, ...block)
  else lines.push(...block)
  return lines.join('\n')
}

/** The view, declared in the text and with a `{ }` block to write into. */
function viewBlock(source: string, index: number): { source: string; model: C4Model; view: C4View } {
  let s = materializeViews(source)
  let model = parseStructurizr(s)
  const v = view(model, index)
  if (v.src!.close === null || v.src!.close === v.src!.line) {
    const lines = split(s)
    const i = v.src!.line - 1
    const text = lines[i]
    const indent = indentOf(text)
    if (v.src!.close === null) {
      if (!v.src!.alone) refuse('this view shares its line with other text')
      lines.splice(i, 1, `${text.replace(/\s+$/, '')} {`, `${indent}}`)
    } else {
      // `systemContext shop { include * }`: one statement per line, so there is a line to write before.
      const open = text.indexOf('{')
      const close = text.lastIndexOf('}')
      if (text.slice(close + 1).trim()) refuse('this view shares its line with other text')
      const body = text.slice(open + 1, close).trim()
      lines.splice(i, 1, `${text.slice(0, open).replace(/\s+$/, '')} {`, ...(body ? [`${deeper(indent)}${body}`] : []), `${indent}}`)
    }
    s = lines.join('\n')
    model = parseStructurizr(s)
  }
  return { source: s, model, view: view(model, index) }
}

/** Write `entries` as the view's `// @layout` line, replacing the one it had. */
function writeLayout(source: string, index: number, entries: Array<[string, C4Point]>): string {
  const { source: s, view: v } = viewBlock(source, index)
  const lines = split(s)
  const text = entries.map(([id, p]) => `${id} ${Math.round(p.x)} ${Math.round(p.y)}`).join(', ')
  const line = `${deeper(indentOf(lines[v.src!.line - 1]))}// ${LAYOUT_MARK} ${text}`
  if (v.src!.layoutLine) lines[v.src!.layoutLine - 1] = line
  else lines.splice(closeAt(lines, v.src!.close), 0, line)
  return lines.join('\n')
}

const translate = (positions: Record<string, C4Point>, renamed: Map<string, string>) =>
  Object.fromEntries(Object.entries(positions).map(([id, p]) => [renamed.get(id) ?? id, p]))

/**
 * Pin every element the view shows: `positions` (by id) for those given —
 * the builder passes everything it has on screen — and where each is drawn
 * now for the rest.
 */
export function placeElements(source: string, viewIndex: number, positions: Record<string, C4Point>): string {
  const ided = withIds(source)
  const wanted = translate(positions, ided.renamed)
  const { source: s, model, view: v } = viewBlock(ided.source, viewIndex)
  const nodes = viewElements(model, v).nodes
  const now = positionsOf(model, v, nodes)
  return writeLayout(s, viewIndex, nodes.map((n) => [n.id, wanted[n.id] ?? now.get(n)!]))
}

/** Back to automatic layout: the view's `// @layout` line goes. */
export function clearLayout(source: string, viewIndex: number): string {
  const v = view(parseStructurizr(source), viewIndex)
  if (!v.src?.layoutLine) return source
  return split(source).filter((_, i) => i !== v.src!.layoutLine! - 1).join('\n')
}

/** What can be added to a view: whatever it would show. */
export function paletteFor(type: C4ViewType): C4Kind[] {
  return type === 'systemContext'
    ? ['person', 'softwareSystem']
    : type === 'container'
      ? ['person', 'softwareSystem', 'container']
      : ['person', 'softwareSystem', 'container', 'component']
}

/**
 * A new element in this view, at `at`, named `name`. It nests where the view
 * says (a container in the system the container view shows, a component in
 * its container); anything the view would not show by itself is included by
 * name. `positions` is what the builder has on screen, so nothing else moves.
 */
export function addElement(
  source: string,
  viewIndex: number,
  kind: C4Kind,
  name: string,
  positions: Record<string, C4Point>,
  at: C4Point,
): { source: string; id: string } {
  const ided = withIds(source)
  let s = ided.source
  let model = parseStructurizr(s)
  const v = view(model, viewIndex)
  if (!paletteFor(v.type).includes(kind)) refuse(`a ${v.type} view cannot hold a ${kind}`)
  const parent =
    kind === 'container' ? (v.type === 'container' ? v.subject : v.subject.parent) : kind === 'component' ? v.subject : null

  // The declaration, at the end of its parent's block (or the model's).
  const lines = split(s)
  const id = newId(new Set(model.elements.map((e) => e.id)), name, kind)
  const decl = `${id} = ${declaration({ kind, name, description: '', technology: '', tags: [] })}`
  if (!parent) {
    const at_ = model.src.model ?? refuse('the model has no model block')
    lines.splice(closeAt(lines, at_.close), 0, `${deeper(indentOf(lines[at_.line - 1]))}${decl}`)
  } else if (parent.src.close !== null) {
    lines.splice(closeAt(lines, parent.src.close), 0, `${deeper(indentOf(lines[parent.src.line - 1]))}${decl}`)
  } else {
    if (!parent.src.alone) refuse(`"${parent.name}" shares its line with other text`)
    const i = parent.src.line - 1
    const indent = indentOf(lines[i])
    lines.splice(i, 1, `${lines[i].replace(/\s+$/, '')} {`, `${deeper(indent)}${decl}`, `${indent}}`)
  }
  s = lines.join('\n')

  // Shown by this view without being named? Otherwise include it.
  model = parseStructurizr(s)
  const added = element(model, id)
  const inner = v.type === 'systemContext' ? false : added.parent?.id === v.subject.id
  if (!inner) {
    const block = viewBlock(s, viewIndex)
    const vl = split(block.source)
    const indent = deeper(indentOf(vl[block.view.src!.line - 1]))
    const include = block.view.include.length ? [] : [`${indent}include *`]
    vl.splice(closeAt(vl, block.view.src!.close), 0, ...include, `${indent}include ${id}`)
    s = vl.join('\n')
  }
  return { source: placeElements(s, viewIndex, { ...translate(positions, ided.renamed), [id]: at }), id }
}

/** `from -> to`, at the end of the model. */
export function connectElements(source: string, fromId: string, toId: string): string {
  const ided = withIds(source)
  const model = parseStructurizr(ided.source)
  const from = element(model, ided.renamed.get(fromId) ?? fromId)
  const to = element(model, ided.renamed.get(toId) ?? toId)
  if (from === to) refuse('an element cannot point at itself')
  const lines = split(ided.source)
  const at = model.src.model ?? refuse('the model has no model block')
  lines.splice(closeAt(lines, at.close), 0, `${deeper(indentOf(lines[at.line - 1]))}${from.id} -> ${to.id}`)
  return lines.join('\n')
}

export interface C4ElementPatch {
  name?: string
  description?: string
  technology?: string
  external?: boolean
  database?: boolean
}

function toggleTag(tags: string[], tag: string, on: boolean | undefined): string[] {
  if (on === undefined) return tags
  const rest = tags.filter((t) => t.toLowerCase() !== tag.toLowerCase())
  return on ? [...rest, tag] : rest
}

/** Rewrite an element's declaration; what precedes the kind (indent, `id =`) and its `{` are kept. */
export function updateElement(source: string, id: string, patch: C4ElementPatch): string {
  const model = parseStructurizr(source)
  const el = element(model, id)
  if (!el.src.alone) refuse(`"${el.name}" shares its line with other text`)
  const next = {
    kind: el.kind,
    name: (patch.name ?? el.name).trim() || el.name,
    description: patch.description ?? el.description,
    technology: patch.technology ?? el.technology,
    tags: toggleTag(toggleTag(el.tags, 'External', patch.external), 'Database', patch.database),
  }
  const lines = split(source)
  const i = el.src.line - 1
  lines[i] = `${lines[i].slice(0, el.src.col)}${declaration(next)}${el.src.opensOnLine ? ' {' : ''}`
  return lines.join('\n')
}

/** Rewrite what a relationship says; its source and destination as written are kept. */
export function updateRelationship(source: string, index: number, patch: { description?: string; technology?: string }): string {
  const rel = parseStructurizr(source).relationships[index] ?? refuse('that relationship is gone')
  if (!rel.src.alone) refuse('this relationship shares its line with other text')
  const args = [patch.description ?? rel.description, patch.technology ?? rel.technology]
  while (args.length && !args[args.length - 1]) args.pop()
  const lines = split(source)
  const i = rel.src.line - 1
  lines[i] = `${lines[i].slice(0, rel.src.cut)}${args.map((a) => ` ${quote(a)}`).join('')}`
  return lines.join('\n')
}

export function deleteRelationship(source: string, index: number): string {
  const rel = parseStructurizr(source).relationships[index] ?? refuse('that relationship is gone')
  if (!rel.src.alone) refuse('this relationship shares its line with other text')
  return split(source).filter((_, i) => i !== rel.src.line - 1).join('\n')
}

/**
 * An element goes with everything inside it, every relationship to or from
 * any of them, and the views about them. A name left in an `include` or a
 * layout line is harmless: the parser skips ids it does not know.
 */
export function deleteElement(source: string, id: string): string {
  const model = parseStructurizr(source)
  const el = element(model, id)
  if (!el.src.alone) refuse(`"${el.name}" shares its line with other text`)
  const doomed = new Set<C4Element>()
  const collect = (e: C4Element) => {
    doomed.add(e)
    e.children.forEach(collect)
  }
  collect(el)
  const drop = new Set<number>()
  const span = (line: number, close: number | null) => {
    for (let l = line; l <= (close ?? line); l++) drop.add(l - 1)
  }
  if (el.src.close !== null) closeAt(split(source), el.src.close)
  span(el.src.line, el.src.close)
  for (const rel of model.relationships) {
    if (!doomed.has(rel.source) && !doomed.has(rel.destination)) continue
    if (drop.has(rel.src.line - 1)) continue
    if (!rel.src.alone) refuse('a relationship to it shares its line with other text')
    drop.add(rel.src.line - 1)
  }
  for (const v of model.views) {
    if (!v.src || !doomed.has(v.subject)) continue
    if (!v.src.alone) refuse('a view of it shares its line with other text')
    span(v.src.line, v.src.close)
  }
  return split(source).filter((_, i) => !drop.has(i)).join('\n')
}

/** The view a click on this element opens, declared if it was not: a system's containers, a container's components. */
export function addDetailView(source: string, id: string): { source: string; viewIndex: number } {
  const ided = withIds(source)
  let model = parseStructurizr(ided.source)
  const el = element(model, ided.renamed.get(id) ?? id)
  const type: C4ViewType | null = el.kind === 'softwareSystem' ? 'container' : el.kind === 'container' ? 'component' : null
  if (!type) refuse(`a ${el.kind} has no level below it`)
  const existing = model.views.findIndex((v) => v.type === type && v.subject === el)
  if (existing >= 0 && model.views[existing].src) return { source: ided.source, viewIndex: existing }
  const s = materializeViews(ided.source)
  model = parseStructurizr(s)
  // Materializing may already have written it (a default view of a system with containers).
  const written = model.views.findIndex((v) => v.type === type && v.subject.id === el.id)
  if (written >= 0) return { source: s, viewIndex: written }
  const lines = split(s)
  const at = model.src.views!
  const indent = deeper(indentOf(lines[at.line - 1]))
  const keys = new Set(model.views.map((v) => v.key))
  let key = `${type}-${el.id}`
  for (let n = 2; keys.has(key); n++) key = `${type}-${el.id}-${n}`
  lines.splice(closeAt(lines, at.close), 0, `${indent}${type} ${el.id} ${quote(key)} {`, `${deeper(indent)}include *`, `${indent}}`)
  const out = lines.join('\n')
  return { source: out, viewIndex: parseStructurizr(out).views.findIndex((v) => v.key === key) }
}

/** A model to start from: a person using a system, one view. */
export function starterModel(names: { user: string; system: string; uses: string }): string {
  return [
    'workspace {',
    '  model {',
    `    user = person ${quote(names.user)}`,
    `    system = softwareSystem ${quote(names.system)}`,
    `    user -> system ${quote(names.uses)}`,
    '  }',
    '  views {',
    '    systemContext system {',
    '      include *',
    '    }',
    '  }',
    '}',
  ].join('\n')
}
