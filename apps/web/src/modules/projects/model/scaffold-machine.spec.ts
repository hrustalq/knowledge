import { describe, expect, it } from 'vitest'
import { createActor } from 'xstate'
import type { Blueprint } from '@knowledge/contracts'
import { scaffoldMachine } from './scaffold-machine'
import { freshInterview } from './interview'

const laidOut: Blueprint = { name: { en: 'Two' }, tree: [{ title: { en: 'A' } }, { title: { en: 'B' } }] }
const blank: Blueprint = { name: { en: 'Blank' }, tree: [] }
const origin = { kind: 'blueprint', key: 'k', builtIn: true, id: null } as const

const running = () => createActor(scaffoldMachine).start()

describe('scaffoldMachine GOTO (browser Back/Forward)', () => {
  it('refuses every step but Start before a blueprint is picked', () => {
    const actor = running()
    for (const step of ['shape', 'conventions', 'create'] as const) {
      actor.send({ type: 'GOTO', step })
      expect(actor.getSnapshot().value).toBe('start')
    }
  })

  it('walks back to Start and forward again without losing the edited blueprint', () => {
    const actor = running()
    actor.send({ type: 'PICK', blueprint: laidOut, origin })
    actor.send({ type: 'NEXT' })
    actor.send({ type: 'GOTO', step: 'start' })
    expect(actor.getSnapshot().value).toBe('start')
    actor.send({ type: 'GOTO', step: 'conventions' })
    expect(actor.getSnapshot().value).toBe('conventions')
    expect(actor.getSnapshot().context.blueprint).toEqual(laidOut)
  })

  it('lets Blank reach Create but never Shape or Conventions', () => {
    const actor = running()
    actor.send({ type: 'PICK', blueprint: blank, origin })
    expect(actor.getSnapshot().value).toBe('create')
    actor.send({ type: 'GOTO', step: 'shape' })
    expect(actor.getSnapshot().value).toBe('create')
    actor.send({ type: 'GOTO', step: 'start' })
    actor.send({ type: 'GOTO', step: 'create' })
    expect(actor.getSnapshot().value).toBe('create')
  })

  it('refuses Shape after Start over cleared the blueprint', () => {
    const actor = running()
    actor.send({ type: 'PICK', blueprint: laidOut, origin })
    actor.send({ type: 'RESTART' })
    actor.send({ type: 'GOTO', step: 'shape' })
    expect(actor.getSnapshot().value).toBe('start')
  })
})

describe('scaffoldMachine interview (#731)', () => {
  const interview = { ...freshInterview('Billing docs for partners'), rounds: [{ questions: [] }] }

  it('keeps the interview across the draft and Back, so Describe it reopens it', () => {
    const actor = running()
    actor.send({ type: 'SET', patch: { interview } })
    actor.send({ type: 'PICK', blueprint: laidOut, origin: { kind: 'described', brief: interview.brief } })
    actor.send({ type: 'BACK' })
    expect(actor.getSnapshot().value).toBe('start')
    expect(actor.getSnapshot().context.interview).toEqual(interview)
  })

  it('drops it on Start over', () => {
    const actor = running()
    actor.send({ type: 'SET', patch: { interview } })
    actor.send({ type: 'RESTART' })
    expect(actor.getSnapshot().context.interview).toBeNull()
  })
})
