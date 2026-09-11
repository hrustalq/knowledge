/**
 * Connector setup as a state machine (docs/features/19).
 *
 * The dialog used to be one long form: every field for every connector kind on
 * screen at once, with no way to tell which of them the credential actually
 * needed to be right for. Setting up Confluence is a *scenario* — say which
 * site and space, hand over a token, prove it reaches something, then decide
 * what the connection should do — and a scenario is a machine, not a form.
 *
 * Two layers, mirroring `@knowledge/workflow`:
 *
 *  - **A per-kind machine** declares that kind's own configuration steps and
 *    nothing else. Confluence asks for a site and then a space; Notion asks for
 *    one optional database; a git remote asks for a repository and then which
 *    branch and folder. These differ because the systems differ, so they are
 *    declared separately rather than switched on inside one step.
 *  - **A core wrapper** owns the spine every kind shares — credential, test,
 *    destination, what-to-do, submit — and invokes the per-kind machine as a
 *    child for its configure phase.
 *
 * Resumable and syncable: `getPersistedSnapshot()` persists the wrapper *and*
 * its invoked child, and `createActor(machine, { snapshot })` restores both, so
 * a half-finished setup survives a reload. The snapshot is plain JSON, which is
 * what would let it be stored server-side later; today it lives in
 * localStorage, which is per-viewer and needs no schema.
 */
import { assign, createActor, fromPromise, sendParent, sendTo, setup, type Snapshot } from 'xstate'
import { connectorKindInfo } from '@knowledge/contracts'
import type {
  ConnectorConflictPolicy,
  ConnectorDirection,
  ConnectorKind,
  ConnectorSyncMode,
  DocumentCategory,
} from '@knowledge/contracts'

/** A step's own copy, resolved through vue-i18n by the component that renders it. */
export interface StepMeta {
  /** Message key for the step's name in the stepper. */
  labelKey: string
  /** Config field keys this step collects, in order. */
  fields: string[]
  /** True on the step that also takes the credential. */
  credential?: boolean
}

export interface SetupContext {
  kind: ConnectorKind
  name: string
  config: Record<string, string>
  credential: string
  projectId: string
  parentId: string | null
  category: DocumentCategory
  direction: ConnectorDirection
  conflict: ConnectorConflictPolicy
  syncIntervalMinutes: number | null
  webhookSecret: string
  pushOnPublish: boolean
  /**
   * How much of a run happens without a person (docs/features/26). New
   * connectors that can walk a tree are offered `review`, because the first
   * pull from a wiki is the one nobody can predict the shape of.
   */
  syncMode: ConnectorSyncMode
  /** Recreate the external tree under the destination parent. */
  preserveHierarchy: boolean
  /** What the last successful test reached — shown, because "OK" proves nothing. */
  testDetail: string | null
  error: string | null
  /** Set once the connector exists. The handle that makes this state syncable. */
  connectorId: string | null
  /** Editing an existing connector skips the parts that are already true. */
  editingId: string | null
}

export type SetupEvent =
  | { type: 'SET'; patch: Partial<SetupContext> }
  | { type: 'SET_FIELD'; key: string; value: string }
  | { type: 'NEXT' }
  | { type: 'BACK' }
  | { type: 'RETRY' }
  | { type: 'SKIP_TEST' }
  | { type: 'SUBMIT' }
  // Sent by the per-kind child machine, not by the UI.
  | { type: 'CONFIG_DONE' }
  | { type: 'CONFIG_BACK' }

// ==========================================================================
// Per-kind configuration machines
// ==========================================================================

/**
 * Each state is one question. `meta` names the fields it collects so the
 * renderer never has to know which kind it is looking at — it reads the current
 * state's meta and draws those inputs.
 */
export interface KindStep {
  name: string
  meta: StepMeta
}

/**
 * Steps in, machine out. The sequence is the declaration — each kind below
 * states its own questions in order, and the linear NEXT/BACK wiring that turns
 * them into a machine is mechanical, so it is written once here rather than
 * four times.
 *
 * Two details carry the navigation:
 *
 *  - The last step does **not** target a final state. A finished child actor
 *    stops, and a stopped child cannot be stepped back into — so instead it
 *    tells the parent it is done and stays where it is, which is what lets Back
 *    from a later step return to the question you actually last answered.
 *  - The first step's BACK is likewise reported upward rather than swallowed,
 *    because "before the first question of this connector" is a place only the
 *    wrapper knows about.
 *
 * The states object is built at runtime, which xstate's config type cannot
 * follow; the cast is confined to one line and every kind's shape is checked by
 * `KindStep` on the way in.
 */
function kindMachine(id: string, steps: KindStep[]) {
  const states: Record<string, unknown> = {}
  steps.forEach((step, i) => {
    states[step.name] = {
      meta: step.meta,
      on: {
        NEXT: steps[i + 1]
          ? { target: steps[i + 1].name }
          : { actions: sendParent({ type: 'CONFIG_DONE' }) },
        BACK: steps[i - 1]
          ? { target: steps[i - 1].name }
          : { actions: sendParent({ type: 'CONFIG_BACK' }) },
      },
    }
  })

  return setup({ types: { events: {} as SetupEvent } }).createMachine({
    id,
    initial: steps[0].name,
    context: {},
    states,
  } as never)
}

type KindMachine = ReturnType<typeof kindMachine>

/**
 * Each kind's own questions, in order. This is the declaration the rest of the
 * file reads: the machine, the stepper and the field renderer are all derived
 * from it, so adding a step to one connector is one entry here.
 */
export const KIND_STEPS: Record<ConnectorKind, KindStep[]> = {
  // Which site, then which space. The token is asked for with the site, because
  // that is the pair the connection test actually needs.
  // Which site, then which space. The token is asked for with the site, because
  // that is the pair the connection test actually needs.
  //
  // `rootPageId` (docs/features/26) rides along with the space rather than
  // taking a step of its own. It is a *refinement* of "which space" — sync this
  // subtree, not all of it — exactly as `subdir` refines markdown-git's
  // repository, and that step carries two optional fields for the same reason.
  // A step per optional field would make everyone press Next past a question
  // most connectors never answer.
  confluence: [
    { name: 'site', meta: { labelKey: 'connectors.step.site', fields: ['baseUrl'], credential: true } },
    { name: 'space', meta: { labelKey: 'connectors.step.space', fields: ['spaceKey', 'rootPageId'] } },
  ],
  // Identical questions to Cloud — the difference is what the answers mean: a
  // self-hosted base URL with no /wiki suffix, and a PAT rather than email:token.
  // CONNECTOR_KIND_INFO carries both of those as the field help and the
  // credential label, so the steps themselves are the same two.
  'confluence-server': [
    { name: 'site', meta: { labelKey: 'connectors.step.site', fields: ['baseUrl'], credential: true } },
    { name: 'space', meta: { labelKey: 'connectors.step.space', fields: ['spaceKey', 'rootPageId'] } },
  ],
  // The site and token, then the JQL that decides which issues become pages.
  jira: [
    { name: 'site', meta: { labelKey: 'connectors.step.site', fields: ['baseUrl'], credential: true } },
    { name: 'scope', meta: { labelKey: 'connectors.step.issues', fields: ['jql'] } },
  ],
  // Notion has no site to name — the integration secret already identifies the
  // workspace — so it is one step, and the database is optional.
  notion: [
    {
      name: 'integration',
      meta: { labelKey: 'connectors.step.integration', fields: ['databaseId'], credential: true },
    },
  ],
  // A git remote: the repository and token, then which branch and folder.
  'markdown-git': [
    { name: 'repo', meta: { labelKey: 'connectors.step.repo', fields: ['repoUrl'], credential: true } },
    { name: 'location', meta: { labelKey: 'connectors.step.location', fields: ['branch', 'subdir'] } },
  ],
}

export const confluenceSetup = kindMachine('confluenceSetup', KIND_STEPS.confluence)
export const confluenceServerSetup = kindMachine('confluenceServerSetup', KIND_STEPS['confluence-server'])
export const jiraSetup = kindMachine('jiraSetup', KIND_STEPS.jira)
export const notionSetup = kindMachine('notionSetup', KIND_STEPS.notion)
export const markdownGitSetup = kindMachine('markdownGitSetup', KIND_STEPS['markdown-git'])

export const SETUP_MACHINES: Record<ConnectorKind, KindMachine> = {
  confluence: confluenceSetup,
  'confluence-server': confluenceServerSetup,
  jira: jiraSetup,
  notion: notionSetup,
  'markdown-git': markdownGitSetup,
}

/** The per-kind steps, for the stepper — read without running the machine. */
export function kindSteps(kind: ConnectorKind): StepMeta[] {
  return KIND_STEPS[kind].map((step) => step.meta)
}

/**
 * Whether this kind's adapter can reproduce the external hierarchy
 * (docs/features/26).
 *
 * Read from `CONNECTOR_KIND_INFO` rather than listed here, so the catalogue the
 * API validates against stays the one place a capability is declared — the same
 * reason the setup form reads its fields from there.
 */
export function canWalkTree(kind: ConnectorKind): boolean {
  return connectorKindInfo(kind)?.capabilities.tree ?? false
}

/** The current sub-step's meta, so the renderer never switches on kind itself. */
export function kindStepMeta(kind: ConnectorKind, stateName: string | null): StepMeta | null {
  return KIND_STEPS[kind].find((step) => step.name === stateName)?.meta ?? null
}

// ==========================================================================
// The core wrapper
// ==========================================================================

export interface SetupServices {
  /** Proves the credential and configuration reach something. */
  test(context: SetupContext): Promise<{ ok: boolean; detail: string | null }>
  /** Creates or updates the connector; resolves to its id. */
  save(context: SetupContext): Promise<string>
}

export const connectorSetupMachine = setup({
  types: {
    context: {} as SetupContext,
    events: {} as SetupEvent,
    input: {} as Partial<SetupContext> & { kind: ConnectorKind },
  },
  actors: {
    // Replaced per-kind at actor creation via `.provide()`; the placeholder keeps
    // the machine definition self-contained and typeable.
    kindSetup: confluenceSetup,
    test: fromPromise<{ ok: boolean; detail: string | null }, SetupContext>(async () => ({
      ok: true,
      detail: null,
    })),
    save: fromPromise<string, SetupContext>(async () => ''),
  },
  guards: {
    // Named guards resolved here in code, exactly as the workflow machines do.
    hasName: ({ context }) => context.name.trim() !== '',
    hasDestination: ({ context }) => context.projectId !== '',
    // Editing an existing connector keeps its stored credential, so an empty
    // box is legitimate there and only a new connector must be tested blind.
    canTest: ({ context }) => context.credential !== '' || context.editingId !== null,
  },
  actions: {
    patch: assign(({ context, event }) =>
      event.type === 'SET' ? { ...context, ...event.patch } : context,
    ),
    patchField: assign(({ context, event }) =>
      event.type === 'SET_FIELD'
        ? { ...context, config: { ...context.config, [event.key]: event.value } }
        : context,
    ),
    clearError: assign({ error: () => null }),
  },
}).createMachine({
  id: 'connectorSetup',
  initial: 'naming',
  context: ({ input }) => ({
    kind: input.kind,
    name: input.name ?? '',
    config: input.config ?? {},
    credential: '',
    projectId: input.projectId ?? '',
    parentId: input.parentId ?? null,
    category: input.category ?? 'other',
    direction: input.direction ?? 'pull',
    conflict: input.conflict ?? 'manual',
    syncIntervalMinutes: input.syncIntervalMinutes ?? null,
    webhookSecret: '',
    pushOnPublish: input.pushOnPublish ?? false,
    // The column defaults are `auto` / false, which is what keeps every
    // connector created before docs/features/26 behaving exactly as it did.
    // A *new* tree-walking connector is offered the opposite, because the
    // first pull from a wiki is the one nobody can predict the shape of — but
    // the offer is a prefilled control, not a forced value.
    syncMode: input.syncMode ?? (canWalkTree(input.kind) ? 'review' : 'auto'),
    preserveHierarchy: input.preserveHierarchy ?? canWalkTree(input.kind),
    testDetail: null,
    error: null,
    connectorId: null,
    editingId: input.editingId ?? null,
  }),
  /**
   * The per-kind machine is invoked at the root, not inside `configuring`, so
   * it stays alive for the whole setup. Invoking it inside the step would stop
   * and re-create it on every entry, which is exactly what made Back from a
   * later step drop you at the connector's first question instead of its last.
   */
  invoke: { src: 'kindSetup', id: 'kind' },
  on: {
    // Field edits are legal in every step; the step decides which are shown.
    SET: { actions: ['patch', 'clearError'] },
    SET_FIELD: { actions: ['patchField', 'clearError'] },
  },
  states: {
    /** One question before anything else: what is this connection called. */
    naming: {
      on: { NEXT: { target: 'configuring', guard: 'hasName' } },
    },

    /**
     * The per-kind machine drives this step. Navigation is forwarded to it and
     * it reports back when it runs off either end, so a kind can add or reorder
     * its own questions without this file changing.
     */
    configuring: {
      on: {
        NEXT: { actions: sendTo('kind', { type: 'NEXT' }) },
        BACK: { actions: sendTo('kind', { type: 'BACK' }) },
        CONFIG_DONE: 'testing',
        CONFIG_BACK: 'naming',
      },
    },

    testing: {
      invoke: {
        src: 'test',
        input: ({ context }) => context,
        onDone: [
          {
            guard: ({ event }) => event.output.ok,
            target: 'destination',
            actions: assign({ testDetail: ({ event }) => event.output.detail, error: () => null }),
          },
          {
            target: 'testFailed',
            actions: assign({ error: ({ event }) => event.output.detail ?? 'Could not connect' }),
          },
        ],
        onError: {
          target: 'testFailed',
          actions: assign({ error: ({ event }) => String((event.error as Error)?.message ?? event.error) }),
        },
      },
    },

    /**
     * A failed test is its own state rather than a flag on the previous one:
     * the reader needs somewhere to stand that says what failed and offers the
     * two honest ways forward — fix it, or proceed knowing it does not work.
     */
    testFailed: {
      on: {
        RETRY: { target: 'testing', actions: 'clearError' },
        BACK: { target: 'configuring', actions: 'clearError' },
        SKIP_TEST: { target: 'destination', actions: 'clearError' },
      },
    },

    destination: {
      on: {
        NEXT: { target: 'options', guard: 'hasDestination' },
        BACK: 'configuring',
      },
    },

    /** "What should this connection do" — the step the whole test was for. */
    options: {
      on: {
        SUBMIT: 'saving',
        BACK: 'destination',
      },
    },

    saving: {
      invoke: {
        src: 'save',
        input: ({ context }) => context,
        onDone: {
          target: 'done',
          actions: assign({ connectorId: ({ event }) => event.output }),
        },
        onError: {
          target: 'options',
          actions: assign({ error: ({ event }) => String((event.error as Error)?.message ?? event.error) }),
        },
      },
    },

    done: { type: 'final' },
  },
})

// ==========================================================================
// Persistence
// ==========================================================================

export type PersistedSetup = Snapshot<unknown>

const STORAGE_KEY = 'kn_connector_setup'

/**
 * Build the actor for one kind, restoring a stored snapshot when it belongs to
 * the same kind. A snapshot from a different kind is discarded rather than
 * coerced: the invoked child would be the wrong machine entirely.
 */
export function createSetupActor(
  kind: ConnectorKind,
  input: Partial<SetupContext> & { kind: ConnectorKind },
  services: SetupServices,
  snapshot?: PersistedSetup,
) {
  const machine = connectorSetupMachine.provide({
    actors: {
      kindSetup: SETUP_MACHINES[kind],
      test: fromPromise<{ ok: boolean; detail: string | null }, SetupContext>(({ input: ctx }) =>
        services.test(ctx),
      ),
      save: fromPromise<string, SetupContext>(({ input: ctx }) => services.save(ctx)),
    },
  })
  // `input` is always supplied: xstate requires it even when a snapshot wins.
  return createActor(machine, { input, ...(snapshot ? { snapshot } : {}) })
}

/**
 * Checked by shape rather than by try/catch around `createActor`: xstate reports
 * a bad snapshot through its async error channel as well as throwing, so a
 * caught exception still surfaces as an unhandled rejection. A snapshot written
 * by an older machine shape must not strand the dialog either way.
 */
function isRestorable(value: unknown, kind: ConnectorKind): value is PersistedSetup {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { status?: unknown; context?: { kind?: unknown } }
  if (typeof candidate.status !== 'string') return false
  return candidate.context?.kind === kind
}

export function loadSetup(kind: ConnectorKind): PersistedSetup | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    return isRestorable(parsed, kind) ? parsed : undefined
  } catch {
    // A private window, cleared site data, or a browser that throws on access.
    return undefined
  }
}

export function saveSetup(snapshot: PersistedSetup): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage being unavailable must never block finishing the setup.
  }
}

export function clearSetup(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* see saveSetup */
  }
}

// ==========================================================================
// Stepper
// ==========================================================================

/** Wrapper states that are steps a person sees, in order. */
const SPINE = ['naming', 'configuring', 'testing', 'destination', 'options'] as const

/**
 * The stepper's labels. The per-kind steps are spliced in where the child runs,
 * so a Confluence setup shows "Site · Space" and a Notion setup shows one step —
 * the flow's length is a fact about the system being connected.
 */
export function stepLabels(kind: ConnectorKind): string[] {
  return [
    'connectors.step.name',
    ...kindSteps(kind).map((step) => step.labelKey),
    'connectors.step.test',
    'connectors.step.destination',
    'connectors.step.options',
  ]
}

/** Which stepper index the given wrapper/child state pair is on. */
export function stepIndex(kind: ConnectorKind, state: string, childState: string | null): number {
  const kinds = kindSteps(kind)
  const childIndex = childState ? Math.max(0, KIND_STEPS[kind].findIndex((s) => s.name === childState)) : 0

  switch (state) {
    case 'naming':
      return 0
    case 'configuring':
      return 1 + childIndex
    case 'testing':
    case 'testFailed':
      return 1 + kinds.length
    case 'destination':
      return 2 + kinds.length
    case 'options':
    case 'saving':
    case 'done':
      return 3 + kinds.length
    default:
      return 0
  }
}

export { SPINE }
