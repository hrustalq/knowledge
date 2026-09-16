import type { DocumentCategory } from '@knowledge/contracts/documents';

// configured sources and destinations. A connector is one configured
// connection; a link is the recorded identity between an external item and a
// page; a run is one sync execution, polled by the client.
// ---------------------------------------------------------------------------

/**
 * The closed catalogue of adapters. Routed by `connectorKindInfo` below, which
 * the settings UI, the create guard and the worker registry all read, so they
 * cannot disagree about what exists.
 */
export const CONNECTOR_KINDS = [
  'confluence',
  'confluence-server',
  'jira',
  'notion',
  'markdown-git',
  'codebase',
] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** 'pull' | 'push' | 'both' — what a connector is allowed to do. */
export type ConnectorDirection = 'pull' | 'push' | 'both';
/** One sync execution only ever moves one way. */
export type ConnectorRunDirection = 'pull' | 'push';
export type ConnectorTrigger = 'manual' | 'schedule' | 'webhook';
/**
 * What to do when the external item and the page both changed since the last
 * sync. 'manual' overwrites nothing: it opens a merge request.
 */
export type ConnectorConflictPolicy = 'manual' | 'external-wins' | 'local-wins';
export type ConnectorRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting-review'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled';

/**
 * How much of a run happens without a person (docs/features/26).
 *
 * `auto` is the default and reproduces the pre-feature behaviour exactly: items
 * are staged and applied in the same pass. The other two exist because a pull
 * from a wiki is not a transfer, it is an edit to somebody's knowledge base.
 */
export type ConnectorSyncMode = (typeof CONNECTOR_SYNC_MODES)[number];

/** Which part of its work a run is in. Distinct from `status`: a run can be paused while discovering. */
export type ConnectorRunPhase = 'discovering' | 'fetching' | 'awaiting-review' | 'applying' | 'reverting';

/** What an adapter can actually do. `push: false` is how Jira says it is pull-only. */
export interface ConnectorCapabilities {
  pull: boolean;
  push: boolean;
  webhook: boolean;
  /**
   * The adapter implements `children()` and can reproduce the external
   * hierarchy. False adapters take the flat `list()` path, unchanged.
   */
  tree: boolean;
}

/** One configurable, non-secret setting an adapter needs (drives the settings form). */
export interface ConnectorConfigField {
  key: string;
  label: string;
  /** `text` renders an input, `select` a dropdown over `options`. */
  kind: 'text' | 'select';
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface ConnectorKindInfo {
  kind: ConnectorKind;
  label: string;
  capabilities: ConnectorCapabilities;
  /** What to paste into the credential box, e.g. 'email:api-token'. */
  credentialLabel: string;
  fields: readonly ConnectorConfigField[];
}

/**
 * Adapter catalogue. Kept in contracts rather than the API so the settings form
 * can render a connector's fields without a round trip, exactly as
 * `IMPORT_FORMATS` lets the drop zone and the reserve guard agree (feature 16).
 */
export const CONNECTOR_KIND_INFO: readonly ConnectorKindInfo[] = [
  {
    kind: 'confluence',
    label: 'Confluence',
    capabilities: { pull: true, push: true, webhook: true, tree: true },
    credentialLabel: 'email:api-token',
    fields: [
      {
        key: 'baseUrl',
        label: 'Site URL',
        kind: 'text',
        required: true,
        placeholder: 'https://your-team.atlassian.net/wiki',
      },
      { key: 'spaceKey', label: 'Space key', kind: 'text', required: true, placeholder: 'ENG' },
      {
        key: 'rootPageId',
        label: 'Root page ID',
        kind: 'text',
        required: false,
        placeholder: '123456',
        help: 'Sync only this page and everything under it. Leave empty for the whole space.',
      },
    ],
  },
  {
    // Confluence Server / Data Center is a different product behind the same
    // name: no /api/v2 at all, a PAT over Bearer instead of `email:api-token`
    // over Basic, and spaces addressed by key rather than by a numeric id. A
    // second kind rather than a variant flag on the first, because the
    // credential hint and the setup questions both differ — and a variant would
    // be enforced by nothing, where a kind is checked against every
    // Record<ConnectorKind, ...> in the API and the web.
    kind: 'confluence-server',
    label: 'Confluence (Server / Data Center)',
    capabilities: { pull: true, push: true, webhook: true, tree: true },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'text',
        required: true,
        placeholder: 'https://confluence.example.com',
        help: 'Self-hosted Confluence. Cloud sites (*.atlassian.net) use the Confluence connector instead.',
      },
      { key: 'spaceKey', label: 'Space key', kind: 'text', required: true, placeholder: 'ENG' },
      {
        key: 'rootPageId',
        label: 'Root page ID',
        kind: 'text',
        required: false,
        placeholder: '123456',
        help: 'Sync only this page and everything under it. Leave empty for the whole space.',
      },
    ],
  },
  {
    kind: 'jira',
    label: 'Jira',
    capabilities: { pull: true, push: false, webhook: true, tree: false },
    credentialLabel: 'email:api-token',
    fields: [
      {
        key: 'baseUrl',
        label: 'Site URL',
        kind: 'text',
        required: true,
        placeholder: 'https://your-team.atlassian.net',
      },
      {
        key: 'jql',
        label: 'JQL',
        kind: 'text',
        required: true,
        placeholder: 'project = ENG AND issuetype = Epic',
        help: 'Which issues become pages.',
      },
    ],
  },
  {
    kind: 'notion',
    label: 'Notion',
    capabilities: { pull: true, push: true, webhook: true, tree: false },
    credentialLabel: 'Internal integration secret',
    fields: [
      {
        key: 'databaseId',
        label: 'Database or page id',
        kind: 'text',
        required: false,
        help: 'Leave empty to sync everything the integration can see.',
      },
    ],
  },
  {
    kind: 'markdown-git',
    label: 'Markdown / Git',
    capabilities: { pull: true, push: true, webhook: true, tree: false },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: 'repoUrl',
        label: 'Repository URL',
        kind: 'text',
        required: true,
        placeholder: 'https://github.com/acme/runbooks',
        help: 'GitHub and GitLab can be pushed to; other hosts are pull-only.',
      },
      { key: 'branch', label: 'Branch', kind: 'text', required: false, placeholder: 'main' },
      {
        key: 'subdir',
        label: 'Subdirectory',
        kind: 'text',
        required: false,
        placeholder: 'docs',
        help: 'Only markdown under this path is synced. An Obsidian vault is just a folder.',
      },
    ],
  },
  {
    // The repository as a subject rather than as a folder of pages
    // (docs/features/27). `markdown-git` mirrors files that are already prose;
    // this reads the code and derives pages that exist nowhere upstream. Same
    // archive download underneath — the difference is that the unit keys are
    // ours, so there is nothing on the far side to push back to.
    kind: 'codebase',
    label: 'Codebase',
    // Pull only, and no webhook in this version. A push event names *files*, and
    // which module a file belongs to is not knowable until the archive has been
    // read — so a webhook could only guess, and every wrong guess seeds an
    // identity-map key for a page that does not exist. Scheduled sync covers the
    // same ground: a module whose files did not change costs a hash, not a call.
    capabilities: { pull: true, push: false, webhook: false, tree: false },
    credentialLabel: 'Personal access token',
    fields: [
      {
        key: 'repoUrl',
        label: 'Repository URL',
        kind: 'text',
        required: true,
        placeholder: 'https://github.com/acme/service',
        help: 'The repository to document. A private repository needs a token with read access.',
      },
      { key: 'branch', label: 'Branch', kind: 'text', required: false, placeholder: 'main' },
      {
        key: 'subdir',
        label: 'Subdirectory',
        kind: 'text',
        required: false,
        placeholder: 'src',
        help: 'Only code under this path is read. Leave empty for the whole repository.',
      },
      {
        key: 'maxModules',
        label: 'Module limit',
        kind: 'text',
        required: false,
        placeholder: '24',
        help: 'At most this many module pages, largest first. Defaults to 24.',
      },
    ],
  },
];

export function connectorKindInfo(kind: string): ConnectorKindInfo | null {
  return CONNECTOR_KIND_INFO.find((k) => k.kind === kind) ?? null;
}

// GET /v1/connectors?workspaceId=
export interface ConnectorSummary {
  id: string;
  workspaceId: string;
  kind: ConnectorKind;
  name: string;
  enabled: boolean;
  config: Record<string, string>;
  /** Secrets are write-only: the value never leaves the API. */
  hasCredential: boolean;
  credentialHint: string | null;
  /** False when SETTINGS_ENCRYPTION_KEY is unset — the UI must disable credential entry. */
  canStoreSecrets: boolean;
  projectId: string;
  parentId: string | null;
  category: DocumentCategory;
  direction: ConnectorDirection;
  conflict: ConnectorConflictPolicy;
  pushOnPublish: boolean;
  /** Default mode for runs this connector starts. */
  syncMode: ConnectorSyncMode;
  /**
   * Recreate the external tree under `parentId`. Default false, so an existing
   * connector keeps landing pages exactly where it does today — turning it on
   * moves nothing already imported.
   */
  preserveHierarchy: boolean;
  /** null = manual only. */
  syncIntervalMinutes: number | null;
  hasWebhookSecret: boolean;
  /** Absolute path to POST external events at; null when no secret is set. */
  webhookPath: string | null;
  capabilities: ConnectorCapabilities;
  linkCount: number;
  lastRun: ConnectorRunInfo | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ListConnectorsResponse {
  workspaceId: string;
  connectors: ConnectorSummary[];
}
export interface ConnectorResponse {
  connector: ConnectorSummary;
}



// POST /v1/connectors/:id/test
export interface ConnectorTestResponse {
  ok: boolean;
  /** Upstream's own message on failure, or a one-line summary of what was reached. */
  detail: string | null;
}

// GET /v1/connectors/:id/links
export interface ConnectorLinkSummary {
  id: string;
  connectorId: string;
  documentId: string;
  documentTitle: string | null;
  externalId: string;
  externalUrl: string | null;
  externalTitle: string | null;
  externalVersion: string | null;
  lastPulledAt: string | null;
  lastPushedAt: string | null;
  createdAt: string;
}
export interface ListConnectorLinksResponse {
  connectorId: string;
  links: ConnectorLinkSummary[];
}

/** One thing a run could not carry — never swallowed, always surfaced. */
export interface ConnectorRunWarning {
  externalId: string | null;
  title: string | null;
  message: string;
}

// GET /v1/connectors/runs/:runId — the poll target.
export interface ConnectorRunInfo {
  id: string;
  connectorId: string;
  workspaceId: string;
  direction: ConnectorRunDirection;
  trigger: ConnectorTrigger;
  status: ConnectorRunStatus;
  /** Frozen from the connector when the run was created. */
  mode: ConnectorSyncMode;
  /** Which part of the work this run is in; null before it starts and once it ends. */
  phase: ConnectorRunPhase | null;
  /** Free-text act ("Fetching 48 pages"); null when the client's own phase shows. */
  stage: string | null;
  /** 0..1 when honest; null means indeterminate. */
  progress: number | null;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  conflicts: number;
  /** Items the tree walk has found so far. Grows while `phase` is 'discovering'. */
  discovered: number;
  applied: number;
  reverted: number;
  /** Items staged and waiting on a person. Drives the review badge. */
  awaitingReview: number;
  warnings: ConnectorRunWarning[];
  error: { message: string } | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
export interface ListConnectorRunsResponse {
  connectorId: string;
  runs: ConnectorRunInfo[];
}
export interface ConnectorRunResponse {
  run: ConnectorRunInfo;
}


// ---------------------------------------------------------------------------
// Run items (docs/features/26) — one row per external page, which is what makes
// a pull watchable, pausable, reviewable and revertable. The tree lives as rows
// rather than inside the run, for the reason `workflow_run_nodes` does: "every
// item awaiting review in this connector" has to be a query.
// ---------------------------------------------------------------------------

/**
 * discovered → fetching → staged → approved → applying → applied,
 * or unchanged | skipped | rejected | failed | reverted.
 *
 * `unchanged` is not `skipped`: the first means the two sides already agree, the
 * second means a person declined it. Collapsing them would make "what did this
 * run actually leave alone" unanswerable.
 */
export type ConnectorRunItemStatus =
  | 'discovered'
  | 'fetching'
  | 'staged'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'unchanged'
  | 'skipped'
  | 'rejected'
  | 'failed'
  | 'reverted';

/** What applying this item would do to the knowledge base. */
export type ConnectorItemAction = 'create' | 'update' | 'unchanged' | 'conflict';

/**
 * These four are `as const` arrays rather than bare unions because the API's
 * DTOs validate against them at runtime — the `CONNECTOR_KINDS` precedent, so
 * the values the server accepts and the ones the web offers cannot drift.
 */
export const CONNECTOR_SYNC_MODES = ['auto', 'review', 'step'] as const;
export const CONNECTOR_ITEM_EVENTS = ['FETCH', 'APPROVE', 'SKIP', 'REJECT', 'RETRY', 'REVERT'] as const;
export const CONNECTOR_RUN_EVENTS = ['PAUSE', 'RESUME', 'FILL', 'NEXT', 'CANCEL', 'APPROVE_ALL'] as const;
export const CONNECTOR_ITEM_AI_OPS = ['cleanup', 'merge'] as const;

export type ConnectorItemEventType = (typeof CONNECTOR_ITEM_EVENTS)[number];
export type ConnectorRunEventType = (typeof CONNECTOR_RUN_EVENTS)[number];

/** Which AI assist to run over a staged item. Never automatic; always asked for. */
export type ConnectorItemAiOp = (typeof CONNECTOR_ITEM_AI_OPS)[number];

export interface ConnectorRunItemInfo {
  id: string;
  runId: string;
  parentItemId: string | null;
  externalId: string;
  externalUrl: string | null;
  externalVersion: string | null;
  title: string;
  depth: number;
  position: number;
  /** The adapter said this branch continues. False once its children are rows. */
  hasChildren: boolean;
  status: ConnectorRunItemStatus;
  action: ConnectorItemAction | null;
  /** What the conversion could not carry, plus 'orphan' when the walk never reached it. */
  warnings: string[];
  /** Set when a model wrote the staged markdown, so a rewritten page is never mistaken for a sent one. */
  aiOp: ConnectorItemAiOp | null;
  /** True once someone edited the staged markdown by hand. */
  edited: boolean;
  documentId: string | null;
  error: string | null;
  updatedAt: string;
}

// GET /v1/connectors/runs/:runId/items
export interface ListConnectorRunItemsResponse {
  runId: string;
  /** Flat rows; the client assembles the tree from `parentItemId`. */
  items: ConnectorRunItemInfo[];
  /** True when the walk stopped at CONNECTOR_SYNC_MAX_ITEMS. */
  truncated: boolean;
}

// GET /v1/connectors/runs/:runId/items/:itemId
export interface ConnectorRunItemResponse {
  item: ConnectorRunItemInfo;
  /** The prepared document, as it would be written. */
  markdown: string;
  /** The unedited conversion, when the staged copy has diverged from it. */
  incoming: string | null;
  /** The page's current content, for a 'conflict' or 'update' item. */
  localHead: string | null;
}





export interface ConnectorRunEventResponse {
  run: ConnectorRunInfo;
}
export interface ConnectorItemEventResponse {
  /** Every row the event touched — one, or a whole subtree. */
  items: ConnectorRunItemInfo[];
  run: ConnectorRunInfo;
}

/**
 * Which run events are legal right now.
 *
 * This pair is the `allowedNodeEvents` idea from `@knowledge/workflow` without
 * the machine: the connector's transitions are few enough that a table states
 * them more clearly than a state chart would, and the point of sharing them is
 * the same — the buttons the web offers and the transitions the API accepts are
 * one list, so they cannot drift.
 */
export function allowedRunEvents(
  run: Pick<ConnectorRunInfo, 'status' | 'mode' | 'awaitingReview' | 'phase' | 'discovered'>,
): ConnectorRunEventType[] {
  // Built in the order the controls are read, with `CANCEL` last: it is the one
  // that throws the run away, and it should not sit between two verbs that do
  // not.
  const events: ConnectorRunEventType[] = [];
  if (run.status === 'running' || run.status === 'queued') events.push('PAUSE');
  if (run.status === 'paused') events.push('RESUME');
  // Stop walking and work with what the walk found. Offered only while there is
  // still tree to walk — once fetching has begun, filling is what the run is
  // already doing — and only once it has found something to fill.
  if (
    run.phase === 'discovering' &&
    run.discovered > 0 &&
    (run.status === 'running' || run.status === 'queued' || run.status === 'paused')
  ) {
    events.push('FILL');
  }
  // `NEXT` releases one more item; only a stepping run has one held back.
  if (run.status === 'awaiting-review' && run.mode === 'step') events.push('NEXT');
  // A paused run is a reviewable one too: its approved items are written by a
  // scoped apply pass that leaves the pause and the discovery frontier alone.
  if ((run.status === 'awaiting-review' || run.status === 'paused') && run.awaitingReview > 0) {
    events.push('APPROVE_ALL');
  }
  if (run.status === 'running' || run.status === 'queued' || run.status === 'paused' || run.status === 'awaiting-review') {
    events.push('CANCEL');
  }
  return events;
}

export function allowedItemEvents(item: Pick<ConnectorRunItemInfo, 'status'>): ConnectorItemEventType[] {
  switch (item.status) {
    case 'staged':
      return ['APPROVE', 'SKIP', 'REJECT', 'RETRY'];
    case 'failed':
      return ['RETRY', 'SKIP'];
    case 'applied':
      // Revert is the whole reason the item keeps `previousRevisionId`.
      return ['REVERT'];
    case 'skipped':
    case 'rejected':
    case 'reverted':
      return ['RETRY'];
    case 'unchanged':
      return ['RETRY'];
    case 'discovered':
      // The walk found this page but has not read it. `FETCH` fills this one
      // (or, with `subtree`, this branch) without waiting for the rest of the
      // tree — and `SKIP` drops a page nobody wants without fetching it first.
      return ['FETCH', 'SKIP'];
    default:
      // fetching / approved / applying are the machine's own; a person
      // interrupts the run, not an item mid-flight.
      return [];
  }
}

// POST /v1/documents/:id/push — publish one page to the connector it is linked to.
export interface PushDocumentResponse {
  run: ConnectorRunInfo;
}

/** The connector attachment shown on a page, when one exists. */
export interface DocumentConnectorLink {
  connectorId: string;
  connectorName: string;
  kind: ConnectorKind;
  canPush: boolean;
  link: ConnectorLinkSummary;
}
export interface DocumentConnectorResponse {
  documentId: string;
  links: DocumentConnectorLink[];
}
