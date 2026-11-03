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
 *
 * The page mirrors the step into `?step=` so the browser's Back/Forward walk
 * the steps. `GOTO` is how a history entry lands; it refuses a step the
 * context cannot stand on, and the page then rewrites the URL to where it is.
 */
import { assign, setup, type Snapshot } from 'xstate'
import type { Blueprint, BlueprintGlossaryTerm, Locale } from '@knowledge/contracts'
import { storedJson } from '@/shared/utils/stored-json'
import type { NodePath } from './blueprint-tree'
import type { DescribeInterview } from './interview'

/**
 * Where the edited blueprint came from: a listed blueprint (so Save can update
 * it, or override the built-in), a project it was derived from (so Shape can
 * say whether the model drafted any of it, and Conventions can offer its
 * terms), or a description the scaffolder drafted it from (so Shape says so,
 * and Describe it reopens with the same words).
 */
export type ScaffoldOrigin =
  | { kind: 'blueprint'; key: string; builtIn: boolean; id: string | null }
  | { kind: 'project'; projectName: string; drafted: boolean; glossary: BlueprintGlossaryTerm[] }
  | { kind: 'described'; brief: string }

export interface ScaffoldContext {
  blueprint: Blueprint | null
  /** Null for a snapshot saved before #716 phase 4b. */
  origin?: ScaffoldOrigin | null
  /** The outline's selected node in Shape. */
  selected: NodePath | null
  name: string
  description: string
  /** The skeleton language. Null until chosen: the page reads the UI locale. */
  locale: Locale | null
  avatarEmoji: string | null
  restricted: boolean
  /**
   * Describe it's interview so far (#731), set after every reply: a reload
   * mid-interview reopens the same round, and Back from Shape the finished one.
   * Kept apart from `origin` so a blueprint picked another way is never
   * labelled described. Absent in snapshots saved before #731.
   */
  interview?: DescribeInterview | null
}

export type ScaffoldEvent =
  | { type: 'PICK'; blueprint: Blueprint; origin: ScaffoldOrigin }
  | { type: 'SET'; patch: Partial<ScaffoldContext> }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'RESTART' }
  /** Browser Back/Forward: land on a step the context can stand on, else stay put. */
  | { type: 'GOTO'; step: ScaffoldStep }

export const SCAFFOLD_STEPS = ['start', 'shape', 'conventions', 'create'] as const
export type ScaffoldStep = (typeof SCAFFOLD_STEPS)[number]

export const emptyContext = (): ScaffoldContext => ({
  blueprint: null,
  origin: null,
  selected: null,
  name: '',
  description: '',
  locale: null,
  avatarEmoji: null,
  restricted: false,
  interview: null,
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
    // Shape and Conventions need pages to stand on; Create needs a blueprint (Blank has an empty tree).
    GOTO: [
      { guard: ({ event }) => event.step === 'start', target: '.start' },
      { guard: ({ context, event }) => event.step === 'shape' && !!context.blueprint?.tree.length, target: '.shape' },
      { guard: ({ context, event }) => event.step === 'conventions' && !!context.blueprint?.tree.length, target: '.conventions' },
      { guard: ({ context, event }) => event.step === 'create' && !!context.blueprint, target: '.create' },
    ],
  },
  states: {
    start: {
      on: {
        PICK: [
          {
            guard: ({ event }) => !event.blueprint.tree.length,
            target: 'create',
            actions: assign({ blueprint: ({ event }) => event.blueprint, origin: ({ event }) => event.origin, selected: null }),
          },
          {
            target: 'shape',
            actions: assign({
              blueprint: ({ event }) => event.blueprint,
              origin: ({ event }) => event.origin,
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
