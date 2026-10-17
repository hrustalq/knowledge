/**
 * Reading an API spec for the reference view (#78, phase 3). Pure, so it is
 * unit-tested and has no opinion about rendering.
 *
 * The API serves the spec with its internal `$ref`s kept — a recursive schema
 * cannot be sent dereferenced — so everything here resolves references itself,
 * one hop at a time, and every walk carries the chain of refs it is inside:
 * meeting one again is a recursion, rendered as a marker rather than followed.
 * Only `#/…` pointers resolve. The server already refused anything else at
 * finalize, so a remote ref here is a corrupt spec, shown as unresolved.
 */
import type { ApiOperationInfo } from '@knowledge/contracts'

type Json = Record<string, unknown>

/** How deep the schema tree opens before it stops. */
export const SCHEMA_DEPTH = 6

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v)
  return typeof v === 'string' && v.trim() ? v : null
}

/** RFC 6901 lookup; null when any segment is missing. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '#') return doc
  const segments = pointer.replace(/^#/, '').split('/').slice(1)
  let node: unknown = doc
  for (const raw of segments) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(node)) node = node[Number(key)]
    else if (isObject(node)) node = node[key]
    else return null
    if (node === undefined) return null
  }
  return node
}

/** Follow `$ref`s until a node that is not one. `ref` is the last pointer followed. */
export function deref(doc: unknown, node: unknown, chain: readonly string[] = []): { node: unknown; ref: string | null; cycle: boolean } {
  let ref: string | null = null
  let current = node
  const seen = new Set(chain)
  while (isObject(current) && typeof current.$ref === 'string') {
    ref = current.$ref
    if (seen.has(ref)) return { node: null, ref, cycle: true }
    seen.add(ref)
    current = ref.startsWith('#') ? resolvePointer(doc, ref) : null
  }
  return { node: current, ref, cycle: false }
}

/** `#/components/schemas/User` → `User`. */
export function refName(ref: string | null): string | null {
  return ref ? (ref.split('/').pop() ?? ref) : null
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export interface SchemaNode {
  name: string
  type: string
  required: boolean
  description: string | null
  /** The named schema this node came from, when it was a `$ref`. */
  refName: string | null
  /** A `$ref` already open above this node: shown, not followed. */
  recursive: boolean
  /** Children were left out at the depth cap. */
  truncated: boolean
  enumValues: string[]
  deprecated: boolean
  children: SchemaNode[]
}

/** The root of a schema as nodes — its properties, or its items' properties. */
export function schemaTree(doc: unknown, schema: unknown, chain: readonly string[] = [], depth = 0): SchemaNode[] {
  const { node, ref, cycle } = deref(doc, schema, chain)
  if (cycle || !isObject(node)) return []
  const nextChain = ref ? [...chain, ref] : chain
  // allOf merges into one object; oneOf / anyOf show each variant.
  if (Array.isArray(node.allOf)) {
    return node.allOf.flatMap((part) => schemaTree(doc, part, nextChain, depth))
  }
  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(node[key])) {
      return node[key].map((variant, i) => {
        const v = deref(doc, variant, nextChain)
        return child(doc, `${key === 'oneOf' ? 'one of' : 'any of'} ${i + 1}`, variant, false, nextChain, depth, v.ref)
      })
    }
  }
  if (node.type === 'array' || (node.items !== undefined && !node.properties)) {
    return schemaTree(doc, node.items, nextChain, depth)
  }
  const required = new Set(Array.isArray(node.required) ? node.required.map(String) : [])
  const props = isObject(node.properties) ? node.properties : {}
  return Object.entries(props).map(([name, value]) => child(doc, name, value, required.has(name), nextChain, depth))
}

function child(
  doc: unknown,
  name: string,
  value: unknown,
  required: boolean,
  chain: readonly string[],
  depth: number,
  refOverride: string | null = null,
): SchemaNode {
  const { node, ref, cycle } = deref(doc, value, chain)
  const n = isObject(node) ? node : {}
  const opens = !cycle && hasChildren(doc, n, ref ? [...chain, ref] : chain)
  const truncated = opens && depth + 1 >= SCHEMA_DEPTH
  return {
    name,
    type: cycle ? 'object' : typeLabel(doc, n, ref ? [...chain, ref] : chain),
    required,
    description: str(n.description),
    refName: refName(refOverride ?? ref),
    recursive: cycle,
    truncated,
    enumValues: Array.isArray(n.enum) ? n.enum.slice(0, 50).map(String) : [],
    deprecated: n.deprecated === true,
    children: opens && !truncated ? schemaTree(doc, n, ref ? [...chain, ref] : chain, depth + 1) : [],
  }
}

function hasChildren(doc: unknown, node: Json, chain: readonly string[]): boolean {
  if (isObject(node.properties) && Object.keys(node.properties).length > 0) return true
  if (Array.isArray(node.allOf) || Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) return true
  if (node.items !== undefined) {
    const { node: items, cycle } = deref(doc, node.items, chain)
    return cycle || (isObject(items) && hasChildren(doc, items, chain))
  }
  return false
}

/** `string<date-time>`, `array<User>`, `integer | null`. */
export function typeLabel(doc: unknown, schema: unknown, chain: readonly string[] = []): string {
  const { node, ref } = deref(doc, schema, chain)
  if (!isObject(node)) return refName(ref) ?? 'any'
  if (Array.isArray(node.oneOf)) return 'oneOf'
  if (Array.isArray(node.anyOf)) return 'anyOf'
  if (Array.isArray(node.allOf)) return refName(ref) ?? 'object'
  const type = Array.isArray(node.type) ? node.type.join(' | ') : str(node.type)
  if (type === 'array') {
    const items = deref(doc, node.items, chain)
    return `array<${refName(items.ref) ?? (isObject(items.node) ? typeLabel(doc, items.node, chain) : 'any')}>`
  }
  const format = str(node.format)
  const base = type ?? (isObject(node.properties) ? 'object' : 'any')
  return `${ref && base === 'object' ? (refName(ref) ?? base) : base}${format ? `<${format}>` : ''}`
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface ParameterView {
  name: string
  in: string
  required: boolean
  deprecated: boolean
  description: string | null
  type: string
  schema: unknown
}

export interface ContentView {
  mediaType: string
  schema: unknown
  example: unknown
}

export interface ResponseView {
  status: string
  description: string | null
  contents: ContentView[]
}

export interface MessageView {
  name: string | null
  summary: string | null
  description: string | null
  payload: unknown
}

export interface OperationView {
  protocol: 'http' | 'async'
  method: string | null
  path: string
  summary: string | null
  description: string | null
  deprecated: boolean
  operationId: string | null
  parameters: ParameterView[]
  requestBody: { required: boolean; description: string | null; contents: ContentView[] } | null
  responses: ResponseView[]
  messages: MessageView[]
  /** Security requirement names, operation-level or else spec-level. */
  security: string[]
}

/** One operation, read out of the spec by the pointer its row carries. */
export function operationView(doc: Json, op: ApiOperationInfo): OperationView | null {
  const raw = deref(doc, resolvePointer(doc, op.pointer)).node
  if (!isObject(raw)) return null
  const base = {
    protocol: op.protocol,
    method: op.method,
    path: op.path,
    summary: str(raw.summary) ?? op.summary,
    description: str(raw.description),
    deprecated: raw.deprecated === true,
    operationId: str(raw.operationId) ?? op.operationId,
  }
  if (op.protocol === 'async') {
    return { ...base, parameters: [], requestBody: null, responses: [], messages: asyncMessages(doc, raw, op), security: [] }
  }
  // Path-level parameters apply unless the operation redeclares the same name + in.
  const pathItem = resolvePointer(doc, op.pointer.slice(0, op.pointer.lastIndexOf('/')))
  const own = asArray(raw.parameters).map((p) => deref(doc, p).node).filter(isObject)
  const inherited = asArray(isObject(pathItem) ? pathItem.parameters : undefined)
    .map((p) => deref(doc, p).node)
    .filter(isObject)
    .filter((p) => !own.some((o) => o.name === p.name && o.in === p.in))
  const parameters = [...inherited, ...own].map((p) => ({
    name: str(p.name) ?? '',
    in: str(p.in) ?? '',
    required: p.required === true,
    deprecated: p.deprecated === true,
    description: str(p.description),
    type: typeLabel(doc, p.schema),
    schema: p.schema,
  }))
  const body = deref(doc, raw.requestBody).node
  const responses = isObject(raw.responses)
    ? Object.entries(raw.responses).map(([status, r]) => {
        const res = deref(doc, r).node
        return {
          status,
          description: isObject(res) ? str(res.description) : null,
          contents: contentsOf(isObject(res) ? res.content : undefined),
        }
      })
    : []
  const security = (Array.isArray(raw.security) ? raw.security : asArray(doc.security))
    .filter(isObject)
    .flatMap((s) => Object.keys(s))
  return {
    ...base,
    parameters,
    requestBody: isObject(body)
      ? { required: body.required === true, description: str(body.description), contents: contentsOf(body.content) }
      : null,
    responses,
    messages: [],
    security: [...new Set(security)],
  }
}

function asyncMessages(doc: Json, raw: Json, op: ApiOperationInfo): MessageView[] {
  // 2.x: `message` (one, or `oneOf`) on the operation. 3.x: `messages` on the
  // operation, else on its channel. A channel row's pointer is the channel.
  const out: unknown[] = []
  const message = deref(doc, raw.message).node
  if (isObject(message)) out.push(...(Array.isArray(message.oneOf) ? message.oneOf : [message]))
  const channel = deref(doc, raw.channel).node
  const named = isObject(raw.messages) ? raw.messages : isObject(channel) && isObject(channel.messages) ? channel.messages : null
  if (named) out.push(...(Array.isArray(named) ? named : Object.values(named)))
  if (out.length === 0 && op.method === null && isObject(raw.messages)) out.push(...Object.values(raw.messages))
  return out
    .map((m) => deref(doc, m).node)
    .filter(isObject)
    .map((m) => ({
      name: str(m.name) ?? str(m.title),
      summary: str(m.summary),
      description: str(m.description),
      payload: m.payload,
    }))
}

function contentsOf(content: unknown): ContentView[] {
  if (!isObject(content)) return []
  return Object.entries(content).map(([mediaType, media]) => ({
    mediaType,
    schema: isObject(media) ? media.schema : undefined,
    example: isObject(media) ? (media.example ?? firstExample(media.examples)) : undefined,
  }))
}

function firstExample(examples: unknown): unknown {
  if (!isObject(examples)) return undefined
  const first = Object.values(examples)[0]
  return isObject(first) ? first.value : undefined
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

/** Operations grouped by first tag, in first-appearance order; untagged last. */
export function groupByTag<T extends { tags: string[] }>(ops: T[]): Array<{ tag: string | null; operations: T[] }> {
  const groups = new Map<string | null, T[]>()
  for (const op of ops) {
    const tag = op.tags[0] ?? null
    groups.set(tag, [...(groups.get(tag) ?? []), op])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : 0))
    .map(([tag, operations]) => ({ tag, operations }))
}

/** Server URLs: OpenAPI's array, or AsyncAPI's map (`host` in 3.x, `url` in 2.x). */
export function serversOf(doc: Json): string[] {
  const s = doc.servers
  if (Array.isArray(s)) return s.filter(isObject).map((x) => str(x.url)).filter((u): u is string => !!u)
  if (isObject(s)) {
    return Object.values(s)
      .filter(isObject)
      .map((x) => str(x.url) ?? [str(x.protocol), str(x.host)].filter(Boolean).join('://'))
      .filter((u): u is string => !!u)
  }
  return []
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** One of the five panel hues (DESIGN.md: a new state takes its colour from the panel ramp). */
export type ApiTone = 'note' | 'tip' | 'warning' | 'important' | 'caution'

/**
 * A method's hue. Emerald, amber and red belong to the indexing lifecycle, so
 * the conventional "GET green, DELETE red" is spoken in the panel ramp instead:
 * reads are note-blue, creates tip-green, replaces warning, patches important,
 * deletes caution. AsyncAPI actions and the rest stay neutral.
 */
export function methodTone(method: string | null): ApiTone | null {
  switch (method?.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'note'
    case 'POST':
      return 'tip'
    case 'PUT':
      return 'warning'
    case 'PATCH':
      return 'important'
    case 'DELETE':
      return 'caution'
    default:
      return null
  }
}

/** A status class's hue: 2xx tip, 3xx note, 4xx warning, 5xx caution; `default` stays neutral. */
export function statusTone(status: string): ApiTone | null {
  return ({ '2': 'tip', '3': 'note', '4': 'warning', '5': 'caution' } as Record<string, ApiTone>)[status[0]] ?? null
}

/** Two rows can share an entity key — an AsyncAPI channel's send and receive — so a row is key + method. */
export function operationRowKey(o: { entityKey: string; method: string | null }): string {
  return `${o.entityKey} ${o.method ?? ''}`
}

/** A path as segments, so `{params}` can be set apart from the literal parts. */
export function pathSegments(path: string): Array<{ text: string; param: boolean }> {
  return path
    .split(/(\{[^}]*\})/g)
    .filter(Boolean)
    .map((text) => ({ text, param: text.startsWith('{') && text.endsWith('}') }))
}
