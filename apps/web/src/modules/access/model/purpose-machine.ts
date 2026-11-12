/**
 * The first-visit purpose wizard (#934) as a state machine: describe → the
 * interview's rounds → review. The interview is stateless on the server, so
 * the rounds live here and every call carries all of them. Whatever goes wrong
 * with the model — none configured, a failed call — lands on review with
 * nothing ticked: the checklist is the whole wizard then.
 *
 * Saving is the page's (`PUT :id/purpose`), not the machine's.
 */
import { assign, fromPromise, setup } from 'xstate'
import type { InterviewAnswer, InterviewRound, PurposeInterviewResponse, WorkspaceUsePick } from '@knowledge/contracts'
import { api } from '@/shared/api/client'
import { getWorkspaceId } from '@/shared/api/api'

export interface PurposeContext {
  description: string
  /** Every round asked; the last one has no `answers` while it is open. */
  rounds: InterviewRound[]
  picks: WorkspaceUsePick[]
  /** Why review opened with no picks from a model, if it did. */
  fallback: 'unavailable' | 'failed' | null
  finish: boolean
}

export type PurposeEvent =
  | { type: 'START'; description: string }
  | { type: 'ANSWER'; answers: Record<string, InterviewAnswer> }
  /** Pick now from the answers so far. */
  | { type: 'FINISH' }
  /** Straight to the checklist, asking nothing. */
  | { type: 'CHECKLIST'; description: string }
  | { type: 'BACK' }

interface InterviewInput {
  description: string
  rounds: InterviewRound[]
  finish: boolean
}

export const purposeMachine = setup({
  types: { context: {} as PurposeContext, events: {} as PurposeEvent },
  actors: {
    interview: fromPromise<PurposeInterviewResponse, InterviewInput>(({ input }) =>
      api.post('/v1/workspaces/{id}/purpose/interview', {
        path: { id: getWorkspaceId() },
        body: {
          ...(input.description ? { description: input.description } : {}),
          // The DTO cannot name the contracts type; the server re-reads every question.
          rounds: input.rounds as unknown as Record<string, unknown>[],
          ...(input.finish ? { finish: true } : {}),
        },
      }),
    ),
  },
}).createMachine({
  id: 'purpose',
  initial: 'describe',
  context: { description: '', rounds: [], picks: [], fallback: null, finish: false },
  states: {
    describe: {
      on: {
        START: {
          target: 'asking',
          actions: assign(({ event }) => ({ description: event.description.trim(), rounds: [], picks: [], fallback: null, finish: false })),
        },
        CHECKLIST: {
          target: 'review',
          actions: assign(({ event }) => ({ description: event.description.trim(), rounds: [], picks: [], fallback: null })),
        },
      },
    },
    asking: {
      invoke: {
        src: 'interview',
        // Only answered rounds travel: Pick now leaves the open one behind.
        input: ({ context }) => ({ description: context.description, rounds: context.rounds.filter((r) => r.answers), finish: context.finish }),
        onDone: [
          {
            guard: ({ event }) => event.output.status === 'asking',
            target: 'round',
            actions: assign(({ context, event }) => ({
              rounds: [...context.rounds.filter((r) => r.answers), ...(event.output.status === 'asking' ? [event.output.round] : [])],
            })),
          },
          {
            guard: ({ event }) => event.output.status === 'done',
            target: 'review',
            actions: assign(({ event }) => ({ picks: event.output.status === 'done' ? event.output.picks : [] })),
          },
          { target: 'review', actions: assign({ fallback: 'unavailable' }) },
        ],
        onError: { target: 'review', actions: assign({ fallback: 'failed' }) },
      },
      on: { BACK: 'describe' },
    },
    round: {
      on: {
        ANSWER: {
          target: 'asking',
          actions: assign(({ context, event }) => ({
            rounds: context.rounds.map((r, i) => (i === context.rounds.length - 1 ? { ...r, answers: event.answers } : r)),
          })),
        },
        FINISH: { target: 'asking', actions: assign({ finish: true }) },
        BACK: 'describe',
      },
    },
    review: { on: { BACK: 'describe' } },
  },
})

export type PurposeStep = 'describe' | 'asking' | 'round' | 'review'
