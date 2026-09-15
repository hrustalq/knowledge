/**
 * Shared workflow machines (docs/features/17).
 *
 * Buildless and single-file, exactly like `@knowledge/contracts`: the package
 * is consumed straight from source by the API, the worker and the browser, and
 * Node only strips types from the entry file itself — it will not follow a
 * relative specifier from one `.ts` file into another. One file keeps all three
 * consumers on the same code with no build step.
 *
 * It carries no server dependency of any kind. That is the point: the browser
 * asks the same "is this event legal?" question the API is about to ask, so the
 * buttons a reviewer sees cannot drift from what the server will accept.
 */
import { createActor, setup, type Snapshot, type SnapshotFrom } from 'xstate';
import {
  AUTHORABLE_RELATION_TYPES,
  WORKFLOW_STEP_KINDS,
  isAuthorableRelationType,
  type WorkflowGraph,
  type WorkflowNodeEventType,
  type WorkflowNodeStatus,
  type WorkflowRunEventType,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowIssueCode,
  type WorkflowValidationIssue,
} from '@knowledge/contracts';

// ==========================================================================
// One node: pending → running → awaitingReview → approved → materialized
// ==========================================================================

/**
 * The lifecycle of a single workflow node (docs/features/17).
 *
 * Three consumers ask this machine the same question: the API validates an
 * incoming event before touching the database, the worker decides what runs
 * next, and the web enables or disables the Approve / Reject / Skip / Retry
 * buttons. Compiling one definition in all three is what stops the buttons
 * drifting from what the server will actually accept.
 *
 * `autoApprove` is a guard rather than a second machine: a step that skips the
 * human gate still passes through `awaitingReview`, so the audit trail and the
 * node statuses are identical whether or not a person clicked.
 */

export interface NodeContext {
  /** Fan-out steps produce children; leaf steps do not. Drives `materialized`. */
  fanOut: boolean;
  autoApprove: boolean;
  /** A step with no `produces` has nothing to write to the page tree. */
  materializes: boolean;
  attempt: number;
  error: string | null;
}

export type NodeEvent =
  | { type: 'START' }
  | { type: 'DONE' }
  | { type: 'FAIL'; error: string }
  | { type: 'APPROVE' }
  | { type: 'REJECT' }
  | { type: 'SKIP' }
  | { type: 'RETRY' }
  | { type: 'MATERIALIZED' };

export const nodeMachine = setup({
  types: {
    context: {} as NodeContext,
    events: {} as NodeEvent,
    input: {} as Partial<NodeContext>,
  },
  guards: {
    // Named guards, resolved here in code. The stored definition only *names*
    // steps and transitions — no executable logic ever comes from the database.
    autoApprove: ({ context }) => context.autoApprove,
    needsReview: ({ context }) => !context.autoApprove,
    materializes: ({ context }) => context.materializes,
    terminalAfterApproval: ({ context }) => !context.materializes,
  },
}).createMachine({
  id: 'workflowNode',
  initial: 'pending',
  context: ({ input }) => ({
    fanOut: input?.fanOut ?? false,
    autoApprove: input?.autoApprove ?? false,
    materializes: input?.materializes ?? false,
    attempt: input?.attempt ?? 0,
    error: input?.error ?? null,
  }),
  states: {
    pending: {
      on: { START: 'running', SKIP: 'skipped' },
    },
    running: {
      on: {
        DONE: [
          { target: 'materializing', guard: 'autoApprove' },
          { target: 'awaitingReview' },
        ],
        FAIL: 'failed',
      },
    },
    awaitingReview: {
      on: {
        APPROVE: [
          { target: 'approved', guard: 'terminalAfterApproval' },
          { target: 'materializing' },
        ],
        REJECT: 'rejected',
        SKIP: 'skipped',
        // Back to the queue, not straight to work: the processor claims
        // `pending` nodes, so a RETRY that jumped to `running` would produce a
        // node nothing ever picks up.
        RETRY: 'pending',
      },
    },
    // An auto-approved step still lands here, so "approved" and "materialized"
    // mean the same thing regardless of who (or what) approved.
    materializing: {
      on: { MATERIALIZED: 'materialized', FAIL: 'failed' },
    },
    approved: { type: 'final' },
    materialized: { type: 'final' },
    rejected: { type: 'final' },
    skipped: { type: 'final' },
    failed: {
      on: { RETRY: 'pending', SKIP: 'skipped' },
    },
  },
});

export type NodeSnapshot = SnapshotFrom<typeof nodeMachine>;

/** Machine state names are camelCase; the column is kebab-case. One map, both ways. */
const NODE_STATE_TO_STATUS: Record<string, WorkflowNodeStatus> = {
  pending: 'pending',
  running: 'running',
  awaitingReview: 'awaiting-review',
  approved: 'approved',
  materializing: 'materializing',
  materialized: 'materialized',
  rejected: 'rejected',
  skipped: 'skipped',
  failed: 'failed',
};
const NODE_STATUS_TO_STATE: Record<WorkflowNodeStatus, string> = Object.fromEntries(
  Object.entries(NODE_STATE_TO_STATUS).map(([state, status]) => [status, state]),
) as Record<WorkflowNodeStatus, string>;

export const nodeStatusOf = (state: string): WorkflowNodeStatus => NODE_STATE_TO_STATUS[state] ?? 'pending';
export const nodeStateOf = (status: WorkflowNodeStatus): string => NODE_STATUS_TO_STATE[status] ?? 'pending';

export const nodeContextFor = (step: WorkflowStep, attempt = 0): NodeContext => ({
  fanOut: step.fanOut,
  autoApprove: step.autoApprove,
  materializes: Boolean(step.produces),
  attempt,
  error: null,
});

export const NODE_TERMINAL_STATUSES: readonly WorkflowNodeStatus[] = [
  'materialized',
  'approved',
  'rejected',
  'skipped',
];

// ==========================================================================
// One run: idle → running ⇄ awaitingReview → completed | failed | cancelled
// ==========================================================================

/**
 * The lifecycle of a whole run (docs/features/17).
 *
 * The run machine deliberately knows nothing about the fan-out tree: nodes live
 * in `workflow_run_nodes` because the feature must answer "every node awaiting
 * review in this project", and a spawned-actor tree persisted as opaque JSON
 * inside the run row cannot be queried across runs. So this machine tracks only
 * whether the run is progressing, parked on a human, paused, or finished — and
 * its snapshot is what makes the run survive a worker crash or a deploy.
 */

export interface RunContext {
  /** Nodes not yet in a terminal state. `0` with nothing running = completed. */
  pending: number;
  awaitingReview: number;
  failed: number;
  error: string | null;
}

export type RunEvent =
  | { type: 'START' }
  | { type: 'PROGRESS'; pending: number; awaitingReview: number; failed: number }
  | { type: 'PARK' }
  | { type: 'RESUME' }
  | { type: 'PAUSE' }
  | { type: 'CANCEL' }
  | { type: 'COMPLETE' }
  | { type: 'FAIL'; error: string };

export const runMachine = setup({
  types: {
    context: {} as RunContext,
    events: {} as RunEvent,
    input: {} as Partial<RunContext>,
  },
}).createMachine({
  id: 'workflowRun',
  initial: 'pending',
  context: ({ input }) => ({
    pending: input?.pending ?? 0,
    awaitingReview: input?.awaitingReview ?? 0,
    failed: input?.failed ?? 0,
    error: input?.error ?? null,
  }),
  states: {
    pending: {
      on: { START: 'running', CANCEL: 'cancelled' },
    },
    running: {
      on: {
        PARK: 'awaitingReview',
        PAUSE: 'paused',
        CANCEL: 'cancelled',
        COMPLETE: 'completed',
        FAIL: 'failed',
      },
    },
    // Not an error state: the normal resting place of a run whose every live
    // node needs a person. A run can sit here for a week.
    awaitingReview: {
      on: {
        RESUME: 'running',
        PAUSE: 'paused',
        CANCEL: 'cancelled',
        COMPLETE: 'completed',
        FAIL: 'failed',
      },
    },
    paused: {
      on: { RESUME: 'running', CANCEL: 'cancelled' },
    },
    completed: { type: 'final' },
    cancelled: { type: 'final' },
    // Retryable: fixing the failed node's prompt and hitting RETRY on it puts
    // the run back to work, so `failed` is not final.
    failed: {
      on: { RESUME: 'running', CANCEL: 'cancelled' },
    },
  },
});

export type RunSnapshot = SnapshotFrom<typeof runMachine>;

const RUN_STATE_TO_STATUS: Record<string, WorkflowRunStatus> = {
  pending: 'pending',
  running: 'running',
  awaitingReview: 'awaiting-review',
  paused: 'paused',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
};
const RUN_STATUS_TO_STATE: Record<WorkflowRunStatus, string> = Object.fromEntries(
  Object.entries(RUN_STATE_TO_STATUS).map(([state, status]) => [status, state]),
) as Record<WorkflowRunStatus, string>;

export const runStatusOf = (state: string): WorkflowRunStatus => RUN_STATE_TO_STATUS[state] ?? 'pending';
export const runStateOf = (status: WorkflowRunStatus): string => RUN_STATUS_TO_STATE[status] ?? 'pending';

export const RUN_TERMINAL_STATUSES: readonly WorkflowRunStatus[] = ['completed', 'cancelled'];

// ==========================================================================
// Definition validation — the editor check, the API gate and the worker gate
// ==========================================================================

/**
 * Validation of a stored definition (docs/features/17).
 *
 * This runs in three places — the editor's live check, the API before a write,
 * and the worker before a run starts — so a definition that saved cleanly can
 * never blow up mid-run on something structural. Anything the runtime relies on
 * (a step id exists, the graph terminates, a producing step names a category)
 * is an `error`; anything merely suspect is a `warning` and still saves.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Steps nothing points at — where a run begins. */
export function entrySteps(graph: WorkflowGraph): WorkflowStep[] {
  const targeted = new Set(graph.steps.flatMap((s) => s.next));
  return graph.steps.filter((s) => !targeted.has(s.id));
}

export function stepById(graph: WorkflowGraph, stepId: string): WorkflowStep | undefined {
  return graph.steps.find((s) => s.id === stepId);
}

/** Direct successors, skipping ids that no longer resolve (a deleted step). */
export function nextSteps(graph: WorkflowGraph, stepId: string): WorkflowStep[] {
  const step = stepById(graph, stepId);
  if (!step) return [];
  return step.next.map((id) => stepById(graph, id)).filter((s): s is WorkflowStep => Boolean(s));
}

function findCycle(graph: WorkflowGraph): string[] | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    if (done.has(id)) return null;
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    visiting.add(id);
    stack.push(id);
    for (const next of stepById(graph, id)?.next ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };

  for (const step of graph.steps) {
    const cycle = walk(step.id);
    if (cycle) return cycle;
  }
  return null;
}

export function validateGraph(graph: WorkflowGraph): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  // `message` is the English default so this package stays usable on its own;
  // the API replaces it with a translation of `code` before responding
  // (docs/features/18). Keep the two in sync when either changes.
  const push = (
    severity: 'error' | 'warning',
    code: WorkflowIssueCode,
    message: string,
    stepId?: string,
    params?: Record<string, string | number>,
  ) => issues.push({ message, code, params, stepId, severity });
  const err = (code: WorkflowIssueCode, message: string, stepId?: string, params?: Record<string, string | number>) =>
    push('error', code, message, stepId, params);
  const warn = (code: WorkflowIssueCode, message: string, stepId?: string, params?: Record<string, string | number>) =>
    push('warning', code, message, stepId, params);

  if (!Array.isArray(graph.steps) || graph.steps.length === 0) {
    err('empty', 'A workflow needs at least one step.');
    return issues;
  }

  const seen = new Set<string>();
  for (const step of graph.steps) {
    if (!SLUG_RE.test(step.id)) {
      err('badId', `Step id "${step.id}" must be lower-case letters, digits and dashes.`, step.id, { id: step.id });
    }
    if (seen.has(step.id)) err('duplicateId', `Duplicate step id "${step.id}".`, step.id, { id: step.id });
    seen.add(step.id);

    if (!WORKFLOW_STEP_KINDS.includes(step.kind)) {
      err('unknownKind', `Unknown step kind "${step.kind}".`, step.id, { kind: String(step.kind) });
    }
    if (!step.title?.trim()) warn('missingTitle', 'Step has no title.', step.id);

    for (const next of step.next ?? []) {
      if (!graph.steps.some((s) => s.id === next)) {
        err('unknownTarget', `Step "${step.id}" points at "${next}", which does not exist.`, step.id, { id: step.id, target: next });
      }
      if (next === step.id) err('selfLoop', `Step "${step.id}" points at itself.`, step.id, { id: step.id });
    }

    if (step.kind === 'ai.generate' || step.kind === 'ai.draft') {
      if (!step.prompt?.user?.trim()) err('missingPrompt', 'An AI step needs a prompt.', step.id);
    }
    // A fan-out step whose children are never materialised produces drafts that
    // can only ever be read inside the run — usually a mistake, never fatal.
    if (step.produces && !step.produces.category) {
      err('producesNeedsCategory', 'A producing step must name the category of the pages it creates.', step.id);
    }
    // The edge type is interpolated into SQL by GraphService and checked there
    // against the same allowlist. Catching it here means the canvas refuses it
    // while it is being drawn, rather than the run stranding a node in
    // `materializing` hours later — after a person already approved the draft.
    if (step.produces?.relationToParent && !isAuthorableRelationType(step.produces.relationToParent)) {
      err(
        'unknownRelationType',
        `"${step.produces.relationToParent}" is not a relation type; use one of ${AUTHORABLE_RELATION_TYPES.join(', ')}.`,
        step.id,
        { type: step.produces.relationToParent },
      );
    }
    if (!step.produces && step.next.length === 0 && step.kind !== 'review') {
      warn('deadEnd', 'This step produces nothing and leads nowhere.', step.id);
    }
    if (step.maxItems !== undefined && (step.maxItems < 1 || step.maxItems > 50)) {
      err('maxItemsRange', 'maxItems must be between 1 and 50.', step.id);
    }
    if (step.fanOut && step.kind !== 'ai.generate') {
      warn('fanOutIgnored', 'Only ai.generate steps fan out; this step will produce a single node.', step.id);
    }
  }

  const cycle = findCycle(graph);
  if (cycle) err('cycle', `The graph has a cycle: ${cycle.join(' → ')}.`, undefined, { cycle: cycle.join(' → ') });

  if (entrySteps(graph).length === 0 && !cycle) {
    err('noEntry', 'Every step is pointed at by another — the workflow has no entry step.');
  }
  if (entrySteps(graph).length > 1) {
    warn('manyEntries', 'The workflow has several entry steps; all of them start when a run begins.');
  }

  return issues;
}

/**
 * Validate and hand back a usable graph, or throw. `compileDefinition` is the
 * single gate every writer goes through, so a persisted definition is always
 * one the runtime can walk.
 */
export function compileDefinition(graph: WorkflowGraph): {
  graph: WorkflowGraph;
  entry: WorkflowStep[];
  issues: WorkflowValidationIssue[];
} {
  const issues = validateGraph(graph);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    throw new WorkflowDefinitionError(errors);
  }
  return { graph, entry: entrySteps(graph), issues };
}

// Plain field assignment rather than TypeScript parameter properties: this
// package is consumed straight from source, and Node's strip-only type removal
// rejects any TS syntax that would have to emit code.
export class WorkflowDefinitionError extends Error {
  readonly issues: WorkflowValidationIssue[];

  constructor(issues: WorkflowValidationIssue[]) {
    super(`Invalid workflow definition: ${issues.map((i) => i.message).join(' ')}`);
    this.name = 'WorkflowDefinitionError';
    this.issues = issues;
  }
}

// ==========================================================================
// Persist and restore: what makes a run survive a crash or a deploy
// ==========================================================================

/**
 * Persist/restore helpers (docs/features/17).
 *
 * XState's `getPersistedSnapshot()` / `createActor(machine, { snapshot })` pair
 * is what makes a run resumable across a worker crash or a deploy. Everything
 * here is deliberately synchronous and side-effect free so the same functions
 * run in the API, in the worker, and in the browser.
 *
 * Node actors are rebuilt from the node's `status` column rather than from a
 * stored snapshot: a node's state is one enum value, and keeping it in a column
 * is what lets "every node awaiting review in this project" be a SQL query.
 * The run's snapshot, which carries counters and history, is stored as JSON.
 */

export type PersistedSnapshot = Snapshot<unknown>;

// --------------------------------------------------------------------- nodes

function nodeActorFor(step: WorkflowStep, status: WorkflowNodeStatus, attempt = 0) {
  const machine = nodeMachine.provide({});
  const actor = createActor(machine, { input: nodeContextFor(step, attempt) });
  actor.start();
  const target = nodeStateOf(status);
  if (actor.getSnapshot().value === target) return actor;

  // Replay the shortest path to the stored status. Statuses are reached by a
  // known sequence, so this is a lookup rather than a search.
  const path: Record<string, NodeEvent[]> = {
    running: [{ type: 'START' }],
    awaitingReview: [{ type: 'START' }, { type: 'DONE' }],
    approved: [{ type: 'START' }, { type: 'DONE' }, { type: 'APPROVE' }],
    materializing: [{ type: 'START' }, { type: 'DONE' }, { type: 'APPROVE' }],
    materialized: [{ type: 'START' }, { type: 'DONE' }, { type: 'APPROVE' }, { type: 'MATERIALIZED' }],
    rejected: [{ type: 'START' }, { type: 'DONE' }, { type: 'REJECT' }],
    skipped: [{ type: 'SKIP' }],
    failed: [{ type: 'START' }, { type: 'FAIL', error: '' }],
  };
  for (const event of path[target] ?? []) actor.send(event);
  return actor;
}

/** Which node events are legal right now — the web's button enablement. */
export function allowedNodeEvents(step: WorkflowStep, status: WorkflowNodeStatus): WorkflowNodeEventType[] {
  const actor = nodeActorFor(step, status);
  const snapshot = actor.getSnapshot();
  const allowed = (['APPROVE', 'REJECT', 'SKIP', 'RETRY'] as const).filter((type) =>
    snapshot.can({ type } as NodeEvent),
  );
  actor.stop();
  return [...allowed];
}

export function canSendNodeEvent(
  step: WorkflowStep,
  status: WorkflowNodeStatus,
  event: WorkflowNodeEventType,
): boolean {
  return allowedNodeEvents(step, status).includes(event);
}

/** Apply an event and report the resulting status. Throws on an illegal event. */
export function nextNodeStatus(
  step: WorkflowStep,
  status: WorkflowNodeStatus,
  event: NodeEvent,
): WorkflowNodeStatus {
  const actor = nodeActorFor(step, status);
  if (!actor.getSnapshot().can(event)) {
    actor.stop();
    throw new WorkflowTransitionError(
      `Cannot ${event.type} a node that is ${status}.`,
      status,
      event.type,
    );
  }
  actor.send(event);
  const next = nodeStatusOf(String(actor.getSnapshot().value));
  actor.stop();
  return next;
}

// ---------------------------------------------------------------------- runs

/**
 * Does this look like a snapshot this machine can restore?
 *
 * Checked by shape rather than by try/catch around `createActor`: xstate
 * reports a bad snapshot through its async error channel as well as throwing,
 * so a caught exception still surfaces as an unhandled rejection. A snapshot
 * written by an older machine shape must not strand the run either way.
 */
function isRestorable(snapshot: unknown): snapshot is PersistedSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const candidate = snapshot as { status?: unknown; value?: unknown };
  if (typeof candidate.status !== 'string') return false;
  if (typeof candidate.value !== 'string') return false;
  return candidate.value in RUN_STATE_NAMES;
}

const RUN_STATE_NAMES: Record<string, true> = {
  pending: true,
  running: true,
  awaitingReview: true,
  paused: true,
  completed: true,
  cancelled: true,
  failed: true,
};

function runActorFrom(status: WorkflowRunStatus, context: Partial<RunContext>, snapshot?: unknown) {
  // A stored snapshot wins; the status column is the fallback for rows written
  // before a snapshot existed (and the belt to the snapshot's braces).
  if (isRestorable(snapshot)) {
    const actor = createActor(runMachine, { input: {}, snapshot });
    actor.start();
    return actor;
  }
  const actor = createActor(runMachine, { input: context });
  actor.start();
  const target = runStateOf(status);
  const path: Record<string, RunEvent[]> = {
    running: [{ type: 'START' }],
    awaitingReview: [{ type: 'START' }, { type: 'PARK' }],
    paused: [{ type: 'START' }, { type: 'PAUSE' }],
    completed: [{ type: 'START' }, { type: 'COMPLETE' }],
    cancelled: [{ type: 'CANCEL' }],
    failed: [{ type: 'START' }, { type: 'FAIL', error: '' }],
  };
  for (const event of path[target] ?? []) actor.send(event);
  return actor;
}

export interface RunTransitionResult {
  status: WorkflowRunStatus;
  snapshot: PersistedSnapshot;
}

export function applyRunEvent(
  status: WorkflowRunStatus,
  event: RunEvent,
  opts: { snapshot?: unknown; context?: Partial<RunContext> } = {},
): RunTransitionResult {
  const actor = runActorFrom(status, opts.context ?? {}, opts.snapshot);
  if (!actor.getSnapshot().can(event)) {
    actor.stop();
    throw new WorkflowTransitionError(`Cannot ${event.type} a run that is ${status}.`, status, event.type);
  }
  actor.send(event);
  const result: RunTransitionResult = {
    status: runStatusOf(String(actor.getSnapshot().value)),
    snapshot: actor.getPersistedSnapshot(),
  };
  actor.stop();
  return result;
}

export function allowedRunEvents(status: WorkflowRunStatus, snapshot?: unknown): WorkflowRunEventType[] {
  const actor = runActorFrom(status, {}, snapshot);
  const current = actor.getSnapshot();
  const allowed = (['PAUSE', 'RESUME', 'CANCEL'] as const).filter((type) =>
    current.can({ type } as RunEvent),
  );
  actor.stop();
  return [...allowed];
}

export function initialRunSnapshot(): PersistedSnapshot {
  const actor = createActor(runMachine, { input: {} });
  actor.start();
  const snapshot = actor.getPersistedSnapshot();
  actor.stop();
  return snapshot;
}

export class WorkflowTransitionError extends Error {
  readonly status: string;
  readonly event: string;

  constructor(message: string, status: string, event: string) {
    super(message);
    this.name = 'WorkflowTransitionError';
    this.status = status;
    this.event = event;
  }
}
