import type { WorkflowGraph, WorkflowValidationIssue } from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'

/**
 * A workflow graph as a file (#1246): the definition's `steps` and `layout`,
 * exactly as the API stores them, so an export is also a valid `graph` body.
 */
export function graphToJson(graph: WorkflowGraph): string {
  return `${JSON.stringify({ steps: graph.steps, layout: graph.layout }, null, 2)}\n`
}

/** A download name from the workflow's name, minus what a file system refuses. */
export function graphFileName(name: string): string {
  const base = name.trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base || 'workflow'}.workflow.json`
}

export type ParsedGraph =
  | { ok: true; graph: WorkflowGraph; issues: WorkflowValidationIssue[] }
  | { ok: false; reason: 'json' | 'shape' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isStep = (v: unknown): boolean =>
  isObject(v) &&
  typeof v.id === 'string' &&
  typeof v.kind === 'string' &&
  typeof v.title === 'string' &&
  typeof v.fanOut === 'boolean' &&
  typeof v.autoApprove === 'boolean' &&
  Array.isArray(v.next) &&
  v.next.every((n) => typeof n === 'string')

const isLayout = (v: unknown): boolean =>
  v === undefined ||
  (isObject(v) && Object.values(v).every((p) => isObject(p) && typeof p.x === 'number' && typeof p.y === 'number'))

/**
 * Read a file back into a graph.
 *
 * Two gates, deliberately different. The shape check refuses anything that is
 * not a graph at all — `validateGraph` itself assumes `next` is an array and
 * would throw. What `validateGraph` then reports is handed back, not refused:
 * a draft exported mid-edit must re-import, and the builder already lists
 * problems and blocks Save until they are fixed. The API compiles the graph
 * again on save, which stays the trust boundary.
 *
 * A whole definition (a `GET /v1/workflows/:id` body) is accepted too: its
 * `graph` is the part that is read.
 */
export function parseGraphJson(text: string): ParsedGraph {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'json' }
  }
  const candidate = isObject(value) && isObject(value.graph) ? value.graph : value
  if (!isObject(candidate) || !Array.isArray(candidate.steps) || !candidate.steps.every(isStep) || !isLayout(candidate.layout)) {
    return { ok: false, reason: 'shape' }
  }
  const graph = candidate as unknown as WorkflowGraph
  return { ok: true, graph, issues: validateGraph(graph) }
}
