/**
 * Creating a project from a blueprint (#716) as a state machine — the
 * workflow wizard's pattern (`workflows/model/wizard-machine.ts`): the
 * snapshot is persisted so a reload keeps the edits, and the page clears it on
 * route leave so the next visit starts at Start.
 *
 * Start → Shape → Conventions → Create. Blank has nothing to shape, so it goes
 * straight to Create and Back from there returns to Start. The blueprint in
 * context is the edited copy; nothing is written until Create, which the page
 * runs (`POST /v1/projects/scaffold`), not the machine.
 */
import { assign, setup, type Snapshot } from 'xstate'
import type { Blueprint, Locale } from '@knowledge/contracts'
import { storedJson } from '@/shared/utils/stored-json'
import type { NodePath } from './blueprint-tree'

export interface ScaffoldContext {
  blueprint: Blueprint | null
  /** The outline's selected node in Shape. */
  selected: NodePath | null
  name: string
  description: string
  /** The skeleton language. Null until chosen: the page reads the UI locale. */
  locale: Locale | null
  avatarEmoji: string | null
  restricted: boolean
}

export type ScaffoldEvent =
  | { type: 'PICK'; blueprint: Blueprint }
  | { type: 'SET'; patch: Partial<ScaffoldContext> }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'RESTART' }

export const SCAFFOLD_STEPS = ['start', 'shape', 'conventions', 'create'] as const
export type ScaffoldStep = (typeof SCAFFOLD_STEPS)[number]

export const emptyContext = (): ScaffoldContext => ({
  blueprint: null,
  selected: null,
  name: '',
  description: '',
  locale: null,
  avatarEmoji: null,
  restricted: false,
})

export const scaffoldMachine = setup({
  types: { context: {} as ScaffoldContext, events: {} as ScaffoldEvent },
  guards: { isBlank: ({ context }) => !context.blueprint?.tree.length },
}).createMachine({
  id: 'project-scaffold',
  initial: 'start',
  context: emptyContext(),
  on: {
    SET: { actions: assign(({ context, event }) => ({ ...context, ...event.patch })) },
    RESTART: { target: '.start', actions: assign(({ context }) => ({ ...emptyContext(), name: context.name })) },
  },
  states: {
    start: {
      on: {
        PICK: [
          {
            guard: ({ event }) => !event.blueprint.tree.length,
            target: 'create',
            actions: assign({ blueprint: ({ event }) => event.blueprint, selected: null }),
          },
          {
            target: 'shape',
            actions: assign({
              blueprint: ({ event }) => event.blueprint,
              selected: () => [0],
              // The blueprint's emoji is the project's face until another is picked.
              avatarEmoji: ({ context, event }) => context.avatarEmoji ?? event.blueprint.icon ?? null,
            }),
          },
        ],
      },
    },
    shape: { on: { NEXT: 'conventions', BACK: 'start' } },
    conventions: { on: { NEXT: 'create', BACK: 'shape' } },
    create: { on: { BACK: [{ guard: 'isBlank', target: 'start' }, { target: 'conventions' }] } },
  },
})

const stored = storedJson<Snapshot<unknown>>('kn_project_wizard')
export const loadSnapshot = stored.load
export const saveSnapshot = stored.save
export const clearSnapshot = stored.clear
