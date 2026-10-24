/**
 * The fixture editor's model (#483): a QA test fixture as rows a form can
 * bind, and back. The server is the validator (`readTestFixture` at finalize);
 * this only shapes. `fromValue` is lenient so a half-written YAML still opens
 * in the step view, and `toValue` writes the canonical body the YAML tab shows.
 */
import { dump, JSON_SCHEMA, load } from 'js-yaml'

export interface Row {
  name: string
  value: string
}

export interface CallDraft {
  kind: 'call'
  id: string
  call: string
  expect: string
  path: Row[]
  query: Row[]
  headers: Row[]
  /** JSON text; empty means no body. */
  body: string
  capture: Row[]
}

export interface ManualDraft {
  kind: 'manual'
  id: string
  manual: string
}

export type StepDraft = CallDraft | ManualDraft

export interface FixtureDraft {
  description: string
  /** An empty value means the run must supply it. */
  inputs: Row[]
  steps: StepDraft[]
  teardown: CallDraft[]
}

/** A body box that is not JSON; `index` counts setup steps then teardown. */
export class BodyError extends Error {
  readonly section: 'steps' | 'teardown'
  readonly index: number
  constructor(section: 'steps' | 'teardown', index: number) {
    super(`${section}[${index}].request.body is not JSON`)
    this.section = section
    this.index = index
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v))
const rows = (v: unknown): Row[] => (isObj(v) ? Object.entries(v).map(([name, value]) => ({ name, value: text(value) })) : [])

export const emptyCall = (id: string): CallDraft => ({
  kind: 'call',
  id,
  call: '',
  expect: '',
  path: [],
  query: [],
  headers: [],
  body: '',
  capture: [],
})

function callFrom(raw: Record<string, unknown>, id: string): CallDraft {
  const req = isObj(raw.request) ? raw.request : {}
  return {
    kind: 'call',
    id,
    call: text(raw.call),
    expect: text(raw.expect),
    path: rows(req.path),
    query: rows(req.query),
    headers: rows(req.headers),
    body: req.body === undefined ? '' : JSON.stringify(req.body, null, 2),
    capture: rows(raw.capture),
  }
}

export function fromValue(value: unknown): FixtureDraft {
  const v = isObj(value) ? value : {}
  const steps = Array.isArray(v.steps) ? v.steps : []
  const teardown = Array.isArray(v.teardown) ? v.teardown : []
  return {
    description: text(v.description),
    inputs: rows(v.inputs),
    steps: steps.filter(isObj).map((s, i) =>
      typeof s.manual === 'string' && s.call === undefined
        ? { kind: 'manual', id: text(s.id) || `step-${i + 1}`, manual: s.manual }
        : callFrom(s, text(s.id) || `step-${i + 1}`),
    ),
    teardown: teardown.filter(isObj).map((s, i) => callFrom(s, text(s.id) || `teardown-${i + 1}`)),
  }
}

/** Rows with a name, as an object; null when there are none, so the key is omitted. */
function object(list: Row[], scalar = false): Record<string, unknown> | null {
  const named = list.filter((r) => r.name.trim())
  if (!named.length) return null
  return Object.fromEntries(named.map((r) => [r.name.trim(), scalar && r.value === '' ? null : r.value]))
}

function callTo(s: CallDraft, section: 'steps' | 'teardown', index: number, withId: boolean): Record<string, unknown> {
  let body: unknown
  if (s.body.trim()) {
    try {
      body = JSON.parse(s.body)
    } catch {
      throw new BodyError(section, index)
    }
  }
  const request = Object.fromEntries(
    (
      [
        ['path', object(s.path)],
        ['query', object(s.query)],
        ['headers', object(s.headers)],
        ['body', body],
      ] as const
    ).filter(([, v]) => v !== null && v !== undefined),
  )
  const expect = Number(s.expect)
  return {
    ...(withId ? { id: s.id } : {}),
    call: s.call,
    ...(Object.keys(request).length ? { request } : {}),
    ...(s.expect.trim() && Number.isInteger(expect) ? { expect } : {}),
    ...(object(s.capture) ? { capture: object(s.capture) } : {}),
  }
}

export function toValue(d: FixtureDraft): Record<string, unknown> {
  const inputs = object(d.inputs, true)
  return {
    fixture: 1,
    ...(d.description.trim() ? { description: d.description.trim() } : {}),
    ...(inputs ? { inputs } : {}),
    steps: d.steps.map((s, i) => (s.kind === 'manual' ? { id: s.id, manual: s.manual } : callTo(s, 'steps', i, true))),
    // Teardown ids are optional; keep only ones a person chose.
    ...(d.teardown.length
      ? { teardown: d.teardown.map((s, i) => callTo(s, 'teardown', i, !/^teardown-\d+$/u.test(s.id))) }
      : {}),
  }
}

export const toText = (d: FixtureDraft, syntax: 'yaml' | 'json') =>
  syntax === 'json' ? `${JSON.stringify(toValue(d), null, 2)}\n` : dump(toValue(d), { lineWidth: 100, noRefs: true })

/** Throws js-yaml's error on a syntax error; the caller keeps the text tab open. */
export const fromText = (raw: string) => fromValue(load(raw, { schema: JSON_SCHEMA }))

/** `{id}` names in an operation path, to prefill its path rows. */
export const pathParams = (path: string) => [...path.matchAll(/\{([^}]+)\}/gu)].map((m) => m[1])

/** The next free `step-N` id. */
export function nextId(taken: Iterable<string>, prefix = 'step'): string {
  const used = new Set(taken)
  let n = 1
  while (used.has(`${prefix}-${n}`)) n++
  return `${prefix}-${n}`
}

export const STARTER = `fixture: 1
description: What this fixture sets up.
steps:
  - id: create
    call: ''
    expect: 201
    capture:
      id: $.id
`
