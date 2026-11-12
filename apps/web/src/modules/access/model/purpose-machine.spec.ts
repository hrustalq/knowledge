import { describe, expect, it } from 'vitest'
import { createActor, fromPromise, waitFor } from 'xstate'
import type { InterviewRound, PurposeInterviewResponse } from '@knowledge/contracts'
import { purposeMachine } from './purpose-machine'

const round: InterviewRound = { questions: [{ type: 'text', name: 'q', label: 'What do you write?' }] }

function run(replies: (PurposeInterviewResponse | Error)[]) {
  const sent: { rounds: InterviewRound[]; finish: boolean }[] = []
  const actor = createActor(
    purposeMachine.provide({
      actors: {
        interview: fromPromise(async ({ input }) => {
          sent.push({ rounds: input.rounds, finish: input.finish })
          const reply = replies.shift()!
          if (reply instanceof Error) throw reply
          return reply
        }),
      },
    }),
  ).start()
  const at = (step: string) => waitFor(actor, (s) => s.matches(step as never))
  return { actor, sent, at }
}

describe('purpose wizard machine (#934)', () => {
  it('walks describe → round → review, sending every answered round back', async () => {
    const { actor, sent, at } = run([
      { status: 'asking', round },
      { status: 'done', picks: [{ use: 'meeting-notes', reason: 'weekly syncs' }], suggestedDisabled: [] },
    ])
    actor.send({ type: 'START', description: ' weekly syncs ' })
    await at('round')
    actor.send({ type: 'ANSWER', answers: { q: 'notes' } })
    const done = await at('review')
    expect(done.context.picks.map((p) => p.use)).toEqual(['meeting-notes'])
    expect(sent).toEqual([
      { rounds: [], finish: false },
      { rounds: [{ ...round, answers: { q: 'notes' } }], finish: false },
    ])
  })

  it('Pick now leaves the open round behind', async () => {
    const { actor, sent, at } = run([{ status: 'asking', round }, { status: 'done', picks: [], suggestedDisabled: [] }])
    actor.send({ type: 'START', description: '' })
    await at('round')
    actor.send({ type: 'FINISH' })
    await at('review')
    expect(sent[1]).toEqual({ rounds: [], finish: true })
  })

  it('no model, or a failed call, lands on the checklist with nothing ticked', async () => {
    for (const [reply, fallback] of [[{ status: 'unavailable' }, 'unavailable'], [new Error('down'), 'failed']] as const) {
      const { actor, at } = run([reply])
      actor.send({ type: 'START', description: 'x' })
      const snap = await at('review')
      expect(snap.context).toMatchObject({ picks: [], fallback })
    }
  })
})
