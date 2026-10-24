import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import type { WorkflowGraph } from '@knowledge/contracts'
import { wizardMachine } from './wizard-machine'

const graph = { steps: [{ id: 's1' }] } as unknown as WorkflowGraph

describe('wizard machine', () => {
  it('CLEAR_TURNS empties the conversation and keeps the proposal', () => {
    const actor = createActor(wizardMachine).start()
    actor.send({ type: 'CHOOSE', lane: 'describe' })
    actor.send({ type: 'SAY', turn: { role: 'user', content: 'from an entity page' } })
    actor.send({ type: 'PROPOSE', graph, name: 'Entity → use cases' })
    actor.send({ type: 'CLEAR_TURNS' })

    const persisted = actor.getPersistedSnapshot() as unknown as { value: string; context: Record<string, unknown> }
    expect(persisted.value).toBe('describe')
    expect(persisted.context.turns).toEqual([])
    expect(persisted.context.graph).toEqual(graph)
    expect(persisted.context.name).toBe('Entity → use cases')
  })
})
