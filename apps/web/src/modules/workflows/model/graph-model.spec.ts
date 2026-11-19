import { describe, expect, it } from 'vitest'
import type { WorkflowGraph, WorkflowStep } from '@knowledge/contracts'
import { COALESCE_MS, graphHistory } from './graph-history'
import { graphToJson, parseGraphJson } from './workflow-json'

const step = (id: string, next: string[] = []): WorkflowStep => ({
  id,
  kind: 'ai.draft',
  title: id,
  next,
  fanOut: false,
  autoApprove: false,
  prompt: { user: `write ${id}` },
  produces: { category: 'other', relationToParent: 'IMPLEMENTS' },
})

function harness() {
  let graph: WorkflowGraph = { steps: [step('a')] }
  let clock = 0
  const h = graphHistory(
    () => graph,
    (g) => (graph = g),
    () => clock,
  )
  return { h, get: () => graph, tick: (ms: number) => (clock += ms) }
}

describe('graph history', () => {
  it('undoes the last five edits in order, and redoes them', () => {
    const { h, get, tick } = harness()
    const seen = [get()]
    for (const id of ['b', 'c', 'd', 'e', 'f']) {
      tick(10)
      h.apply({ steps: [...get().steps, step(id)] })
      seen.push(get())
    }
    for (let i = 4; i >= 0; i--) {
      h.undo()
      expect(get()).toBe(seen[i])
    }
    expect(h.canUndo.value).toBe(false)
    h.redo()
    h.redo()
    expect(get()).toBe(seen[2])
  })

  it('coalesces a keyed burst into one entry, and splits it after a pause', () => {
    const { h, get, tick } = harness()
    const start = get()
    for (const title of ['w', 'wr', 'wri']) {
      tick(100)
      h.apply({ steps: [{ ...step('a'), title }] }, 'prompt:a')
    }
    tick(COALESCE_MS)
    h.apply({ steps: [{ ...step('a'), title: 'write' }] }, 'prompt:a')
    h.undo()
    expect(get().steps[0]!.title).toBe('wri')
    h.undo()
    expect(get()).toBe(start)
  })

  it('a new edit drops the redo branch', () => {
    const { h, get } = harness()
    h.apply({ steps: [...get().steps, step('b')] })
    h.undo()
    h.apply({ steps: [...get().steps, step('c')] })
    expect(h.canRedo.value).toBe(false)
  })
})

describe('workflow json', () => {
  it('an export re-imports into an identical graph', () => {
    const graph: WorkflowGraph = {
      steps: [step('a', ['b']), step('b')],
      layout: { a: { x: 0, y: 0 }, b: { x: 312, y: 0 } },
    }
    const parsed = parseGraphJson(graphToJson(graph))
    expect(parsed.ok && parsed.graph).toEqual(graph)
    expect(parsed.ok && parsed.issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  it('keeps a graph that fails validation, with its problems', () => {
    const parsed = parseGraphJson(graphToJson({ steps: [step('a', ['b']), step('b', ['a'])] }))
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.issues.some((i) => i.code === 'cycle')).toBe(true)
  })

  it('reads the graph out of a whole definition', () => {
    const parsed = parseGraphJson(JSON.stringify({ id: 'x', name: 'n', graph: { steps: [step('a')] } }))
    expect(parsed.ok && parsed.graph.steps.map((s) => s.id)).toEqual(['a'])
  })

  it('refuses what is not a graph', () => {
    expect(parseGraphJson('{')).toEqual({ ok: false, reason: 'json' })
    expect(parseGraphJson('{"steps":[{"id":"a"}]}')).toEqual({ ok: false, reason: 'shape' })
    expect(parseGraphJson('{"steps":[],"layout":{"a":{"x":"1"}}}')).toEqual({ ok: false, reason: 'shape' })
  })
})
