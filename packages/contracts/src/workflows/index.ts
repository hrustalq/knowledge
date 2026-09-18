import type { DocumentCategory, RelationInput } from '@knowledge/contracts/documents';
import type { AuthorableRelationType } from '@knowledge/contracts/graph';

// ---------------------------------------------------------------------------
// A workflow definition is a graph of steps run against a source page: one
// entity fans out into use-cases, each use-case into API endpoints and frontend
// pages. Every step parks its result as a *draft* on the run; nothing enters
// the page tree until a person approves it. The step catalogue is closed and
// each kind has an executor registered in code, so a "dynamic" workflow is
// always data — the database never carries executable logic.

/** Step kinds. Closed set: each maps to an executor in the worker. */
export const WORKFLOW_STEP_KINDS = [
  /** Fan-out: the model returns a list of items, each becoming a child node. */
  'ai.generate',
  /** Writes one node's full markdown body, with tools (search / read / graph). */
  'ai.draft',
  /** Deterministic: runs a knowledge search and attaches hits to the node input. */
  'search',
  /** A pure human gate — no model call. */
  'review',
  /**
   * Report back to the issue this run is about (docs/features/32).
   *
   * Deterministic, like `search`, and the only step kind whose effect lands
   * outside the workspace — which is why it acts on the work item already
   * attached to the run's source page rather than taking a number from the
   * graph. A definition cannot name somebody else's issue.
   */
  'task.update',
] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** Run lifecycle. `paused` is operator-initiated; `awaiting-review` is the
 *  machine parking itself because every live node needs a human. */
export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'awaiting-review',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** Node lifecycle. `materialized` is the only status that implies a Document. */
export const WORKFLOW_NODE_STATUSES = [
  'pending',
  'running',
  'awaiting-review',
  'approved',
  'materializing',
  'materialized',
  'rejected',
  'skipped',
  'failed',
] as const;
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

/** Events a client may send at a node. Mirrors `nodeMachine`'s event union —
 *  the web enables buttons from the compiled machine, so this list and the
 *  machine cannot drift. */
export const WORKFLOW_NODE_EVENTS = ['APPROVE', 'REJECT', 'SKIP', 'RETRY'] as const;
export type WorkflowNodeEventType = (typeof WORKFLOW_NODE_EVENTS)[number];

export const WORKFLOW_RUN_EVENTS = ['PAUSE', 'RESUME', 'CANCEL'] as const;
export type WorkflowRunEventType = (typeof WORKFLOW_RUN_EVENTS)[number];

/** What a step's approved drafts become when materialised. */
export interface WorkflowStepProduces {
  category: DocumentCategory;
  /**
   * Edge type written from the produced page to the node's parent page.
   *
   * Narrowed so a definition cannot name a type the graph will refuse:
   * `assertEdgeType` throws at materialize time, which is after a person has
   * already approved the draft. `validateGraph` enforces the same rule on
   * definitions that arrive as plain JSON.
   */
  relationToParent: AuthorableRelationType;
  /** Nest the produced page under the parent page (feature 08). */
  nestUnderParent?: boolean;
}

/** Scope handed to a step's tools and search — the "filters" of the feature. */
export interface WorkflowStepFilters {
  categories?: DocumentCategory[];
  projectIds?: string[];
  tags?: string[];
  limit?: number;
}

export interface WorkflowStep {
  /** Stable slug, unique within the definition. Referenced by `next` and by
   *  `workflow_run_nodes.step_id`, so renaming one orphans a running node. */
  id: string;
  kind: WorkflowStepKind;
  title: string;
  description?: string;
  /** Downstream step ids. Several entries = the fan-out of the definition
   *  graph (one use-case feeds both `api-endpoints` and `frontend-pages`). */
  next: string[];
  /** Does this step produce N children (a list) or refine its own node? */
  fanOut: boolean;
  /** Skip the human gate — the step's drafts materialise as soon as they land. */
  autoApprove: boolean;
  /** Hard cap on fan-out width, so one hallucinated list cannot open 200 nodes. */
  maxItems?: number;
  produces?: WorkflowStepProduces;
  prompt?: { system?: string; user: string };
  /** Names from the assistant tool registry this step may call. */
  tools?: string[];
  skillIds?: string[];
  /** Pin an `ai_providers` profile for this step (feature 12 routing). */
  providerId?: string | null;
  filters?: WorkflowStepFilters;
}

export interface WorkflowGraph {
  steps: WorkflowStep[];
  /** Editor-only canvas coordinates, keyed by step id. Ignored by the runtime. */
  layout?: Record<string, { x: number; y: number }>;
}

export interface WorkflowTrigger {
  /** Offer a Run button on matching pages and in /workflows. */
  manual: boolean;
  /** Start a run automatically when `events` fire on a matching page.
   *  Defaults false: the failure mode of an always-on trigger is an LLM
   *  avalanche across a whole workspace. */
  autoStart: boolean;
  events: string[];
  /** Only pages in these categories trigger. Empty = every category. */
  categories: DocumentCategory[];
}

export interface WorkflowDefinitionInfo {
  id: string;
  workspaceId: string;
  /** null = available to every project in the workspace. */
  projectId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  graph: WorkflowGraph;
  trigger: WorkflowTrigger;
  createdAt: string;
  updatedAt: string;
}

/**
 * Machine-readable identity of a graph problem. `validateGraph` emits these so
 * the message can be translated once, server-side, instead of the catalog being
 * duplicated into both the API and the web (docs/features/18).
 */
export type WorkflowIssueCode =
  | 'empty'
  | 'badId'
  | 'duplicateId'
  | 'unknownKind'
  | 'missingTitle'
  | 'unknownTarget'
  | 'selfLoop'
  | 'missingPrompt'
  | 'producesNeedsCategory'
  /** `produces.relationToParent` names an edge type the graph would refuse. */
  | 'unknownRelationType'
  | 'deadEnd'
  | 'maxItemsRange'
  | 'fanOutIgnored'
  | 'cycle'
  | 'noEntry'
  | 'manyEntries';

/** One problem found by `compileDefinition` — surfaced live in the editor. */
export interface WorkflowValidationIssue {
  /** Absent when the problem is the graph as a whole (a cycle, no entry step). */
  stepId?: string;
  /**
   * Already localized by the API to the caller's language — render it as-is.
   * packages/workflow fills it with English, which is what a direct consumer of
   * the package (or a worker path with no request) gets.
   */
  message: string;
  /** What went wrong, independent of language. Branch on this, never on `message`. */
  code: WorkflowIssueCode;
  /** Interpolation values for `code`; keys match the `{name}` slots in the catalog. */
  params?: Record<string, string | number>;
  severity: 'error' | 'warning';
}

export interface WorkflowNodeDraft {
  title: string;
  markdown: string;
  frontmatter?: Record<string, unknown>;
  relations?: RelationInput[];
  /** Free-form summary the model produced alongside the body, shown in the tree. */
  summary?: string;
}

export interface WorkflowRunNodeInfo {
  id: string;
  runId: string;
  parentId: string | null;
  stepId: string;
  status: WorkflowNodeStatus;
  draft: WorkflowNodeDraft | null;
  /** Set once approved and materialised. */
  documentId: string | null;
  error: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunInfo {
  id: string;
  workspaceId: string;
  projectId: string;
  definitionId: string;
  definitionName: string;
  rootDocumentId: string;
  rootDocumentTitle: string | null;
  status: WorkflowRunStatus;
  error: string | null;
  /** 'manual' | 'trigger' | 'mcp' — how the run came to exist. */
  startedBy: string;
  createdBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Counts for list rows, so a card never has to fetch the node tree. */
  nodeStats: { total: number; awaitingReview: number; materialized: number; failed: number };
}

// GET /v1/workflows?workspaceId=&projectId=
export interface ListWorkflowsResponse {
  workflows: WorkflowDefinitionInfo[];
}




export interface ValidateWorkflowResponse {
  valid: boolean;
  issues: WorkflowValidationIssue[];
}

/**
 * One turn of the architect conversation (docs/features/17).
 *
 * Deliberately not an `assistant_threads` row: designing a chain is a scenario
 * with an end — you leave with a definition — not a conversation worth keeping,
 * and a saved transcript whose product is a saved workflow is the same fact
 * stored twice. The wizard holds the turns and sends them back each time.
 */
export interface WorkflowDraftMessage {
  role: 'user' | 'assistant';
  content: string;
}


export interface DraftWorkflowResponse {
  /** false when the workspace has no usable provider — the wizard says so and
   *  offers the manual lane rather than failing. */
  enabled: boolean;
  /** What the architect says back: a question, or what it just changed. */
  reply: string;
  /** A complete proposal, or null while it is still asking. */
  graph: WorkflowGraph | null;
  /** Offered alongside a graph; the wizard pre-fills its name field with it. */
  name: string | null;
  description: string | null;
  /**
   * Issues from compiling the proposal here, before it is returned. The wizard
   * therefore never holds a graph the save would reject — the same guarantee
   * `validate` gives the canvas, applied to the model's output.
   */
  issues: WorkflowValidationIssue[];
}

// GET /v1/workflows/runs?workspaceId=&projectId=&definitionId=&status=&documentId=
export interface ListWorkflowRunsResponse {
  runs: WorkflowRunInfo[];
  nextCursor: string | null;
  counts: Record<WorkflowRunStatus, number>;
}


// GET /v1/workflows/runs/:id
export interface WorkflowRunResponse {
  run: WorkflowRunInfo;
  /** The definition as frozen at start — editing the definition afterwards
   *  must not change what a run in flight is doing. */
  graph: WorkflowGraph;
  nodes: WorkflowRunNodeInfo[];
}



export interface WorkflowNodeEventResponse {
  node: WorkflowRunNodeInfo;
  run: WorkflowRunInfo;
}

// GET /v1/documents/:id/workflow-runs
export interface DocumentWorkflowRunsResponse {
  documentId: string;
  runs: WorkflowRunInfo[];
  /** Definitions that may be started against this page right now. */
  available: Array<{ id: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Connectors (docs/features/19) — external systems as first-class, workspace
