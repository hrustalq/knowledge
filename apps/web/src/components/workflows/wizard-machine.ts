/**
 * Creating a workflow as a state machine (docs/features/17).
 *
 * Creating one used to be a button that made a row: a definition called
 * "Workflow 2" holding one seeded example step, dropped into an editor with no
 * indication of what the four kinds meant or what the thing you had just made
 * would do. Everything that decides whether a chain is any good — what it runs
 * against, how deep it goes, whether it publishes on its own — was reachable
 * only by finding it afterwards.
 *
 * So this is a scenario, and a scenario is a machine rather than a form. It
 * follows `connectors/setup-machines.ts`: one small wrapper, `getPersistedSnapshot`
 * into localStorage so closing the tab does not lose the conversation, and Back
 * that lands where you actually were.
 *
 * Two lanes, chosen first and never merged:
 *
 * - **describe** — turns with the architect (`POST /v1/workflows/draft`), each
 *   returning either a question or a proposal. The model designs; nothing is
 *   saved and the canvas afterwards is where it becomes real.
 * - **draw** — pick a starting shape and go. A blank canvas is a legitimate
 *   choice, but it is the *last* option rather than the only one: the shipped
 *   patterns are how an operator learns what a chain is shaped like.
 *
 * Both lanes converge on one review step, because the questions that follow —
 * what is it called, when does it start — are the same either way, and the
 * proposal has to be read before it is saved whichever route produced it.
 */
import { assign, setup, type Snapshot } from 'xstate'
import type { WorkflowGraph, WorkflowTrigger } from '@knowledge/contracts'

export type WizardLane = 'describe' | 'draw'

export interface WizardTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface WizardContext {
  lane: WizardLane | null
  /** The conversation so far. Empty in the draw lane. */
  turns: WizardTurn[]
  graph: WorkflowGraph | null
  name: string
  description: string
  trigger: WorkflowTrigger
  /** Set when the architect cannot run, so the UI offers the other lane. */
  aiDisabled: boolean
  error: string | null
}

export type WizardEvent =
  | { type: 'CHOOSE'; lane: WizardLane }
  | { type: 'SET'; patch: Partial<WizardContext> }
  | { type: 'PROPOSE'; graph: WorkflowGraph; name?: string | null; description?: string | null }
  | { type: 'SAY'; turn: WizardTurn }
  | { type: 'AI_UNAVAILABLE' }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'RESTART' }

export const DEFAULT_TRIGGER: WorkflowTrigger = {
  manual: true,
  // Off, like the server's own default. The failure mode of an always-on
  // trigger is one edit fanning out into dozens of model calls across a
  // workspace, so turning it on has to be something a person did on purpose.
  autoStart: false,
  events: ['revision.indexed'],
  categories: [],
}

export const WIZARD_STEPS = ['approach', 'design', 'review'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** Which numbered step of the stepper a state belongs to. */
export function stepOf(state: string): WizardStep {
  if (state === 'approach') return 'approach'
  if (state === 'review') return 'review'
  return 'design'
}

const emptyContext = (): WizardContext => ({
  lane: null,
  turns: [],
  graph: null,
  name: '',
  description: '',
  trigger: { ...DEFAULT_TRIGGER },
  aiDisabled: false,
  error: null,
})

export const wizardMachine = setup({
  types: {
    context: {} as WizardContext,
    events: {} as WizardEvent,
  },
  guards: {
    // Advancing out of the design step needs something to review. In the draw
    // lane a pattern is always picked, so this only ever gates the architect —
    // and it is why "Continue" cannot be pressed while it is still asking.
    hasGraph: ({ context }) => !!context.graph?.steps.length,
  },
}).createMachine({
  id: 'workflow-wizard',
  initial: 'approach',
  context: emptyContext(),
  on: {
    SET: { actions: assign(({ context, event }) => ({ ...context, ...event.patch })) },
    RESTART: { target: '.approach', actions: assign(() => emptyContext()) },
  },
  states: {
    approach: {
      on: {
        CHOOSE: [
          { guard: ({ event }) => event.lane === 'describe', target: 'describe', actions: assign({ lane: 'describe' }) },
          { target: 'draw', actions: assign({ lane: 'draw' }) },
        ],
      },
    },

    describe: {
      on: {
        SAY: { actions: assign({ turns: ({ context, event }) => [...context.turns, event.turn] }) },
        PROPOSE: {
          actions: assign({
            graph: ({ event }) => event.graph,
            // The architect's name only fills an empty field: re-proposing must
            // not overwrite a name the operator has already typed over it.
            name: ({ context, event }) => context.name || event.name || '',
            description: ({ context, event }) => context.description || event.description || '',
          }),
        },
        AI_UNAVAILABLE: { actions: assign({ aiDisabled: true }) },
        NEXT: { guard: 'hasGraph', target: 'review' },
        BACK: { target: 'approach' },
      },
    },

    draw: {
      on: {
        NEXT: { guard: 'hasGraph', target: 'review' },
        BACK: { target: 'approach' },
      },
    },

    review: {
      on: {
        // Back returns to the lane you came through, not to a shared step:
        // landing a describe-lane operator on the pattern picker would lose the
        // conversation that produced what they are looking at.
        BACK: [
          { guard: ({ context }) => context.lane === 'describe', target: 'describe' },
          { target: 'draw' },
        ],
      },
    },
  },
})

const STORAGE_KEY = 'kn_wf_wizard'

/**
 * The snapshot is plain JSON, which is what would let it move server-side
 * later; today it is per-viewer and needs no schema.
 */
export function loadSnapshot(): Snapshot<unknown> | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Snapshot<unknown>) : undefined
  } catch {
    return undefined
  }
}

export function saveSnapshot(snapshot: Snapshot<unknown>) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* private mode */
  }
}

export function clearSnapshot() {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* private mode */
  }
}
