// The platform admin console (#1235): what its routes answer. Every route is
// `@PlatformAdmin()`; nothing here is shown to a workspace member.

// --- configuration (#1237) -------------------------------------------------

/**
 * Where an env key is shown in the console. Derived from the key's name
 * (`envGroupOf` in apps/api config/env-report.ts), never stored.
 */
export const ENV_GROUPS = [
  'core',
  'storage',
  'auth',
  'mail',
  'ai',
  'agents',
  'memory',
  'ingestion',
  'search',
  'quality',
  'publishing',
  'connectors',
  'chat',
  'memos',
  'live',
  'other',
] as const;
export type EnvGroup = (typeof ENV_GROUPS)[number];

/** `env`: the environment set the key. `default`: the schema's default (or unset, for an optional key). */
export type EnvSource = 'env' | 'default';

export interface AdminConfigEntry {
  key: string;
  group: EnvGroup;
  source: EnvSource;
  /** A credential, token, private key or DSN that can carry one: `value` is always null. */
  secret: boolean;
  /** The key resolved to something non-empty. The only fact a secret reports. */
  set: boolean;
  /**
   * The effective value as the process resolved it; null for a secret or an
   * unset optional key. A URL's userinfo is stripped even when the key is not
   * listed as secret.
   */
  value: string | number | boolean | null;
}

export interface AdminConfigResponse {
  /** The process whose configuration this is. Workers, the learner and the git remote resolve their own. */
  process: 'api';
  version: string;
  entries: AdminConfigEntry[];
}

// --- monitoring (#1238) ----------------------------------------------------

/** The long-running entrypoints that write a heartbeat (`OpsBeaconModule`). */
export const OPS_PROCESS_KINDS = ['api', 'worker', 'learner', 'git'] as const;
export type OpsProcessKind = (typeof OPS_PROCESS_KINDS)[number];

export type AdminDependencyName = 'postgres' | 'redis' | 'minio' | 'arcadedb' | 'opensearch' | 'searxng';

export interface AdminDependency {
  name: AdminDependencyName;
  /** `off`: not configured on this deployment (OpenSearch, SearXNG), so not probed. */
  status: 'up' | 'down' | 'off';
  /** How long the probe took; null when not probed. A timed-out probe reports the timeout. */
  latencyMs: number | null;
  /** Why it is down, with any URL credentials stripped. */
  error: string | null;
}

export interface AdminQueue {
  name: string;
  /** Null when the counts could not be read (Redis down). `waiting` includes a paused queue's jobs and prioritized ones. */
  counts: { waiting: number; active: number; delayed: number; failed: number } | null;
}

export interface AdminProcessInstance {
  host: string;
  pid: number;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  /** Heard from within the heartbeat TTL. A silent instance is dropped soon after. */
  live: boolean;
}

export interface AdminProcess {
  kind: OpsProcessKind;
  /** The API and the worker always run; the learner and the git remote only while their env flag is on. */
  expected: boolean;
  instances: AdminProcessInstance[];
}

export interface AdminTick {
  process: OpsProcessKind;
  /** The sweeper's class name. */
  name: string;
  host: string;
  intervalMs: number | null;
  lastAt: string;
  ok: boolean;
  ms: number;
  /** No pass for more than three intervals (plus a minute). Derived when read. */
  late: boolean;
}

export interface AdminHealthResponse {
  checkedAt: string;
  version: string;
  dependencies: AdminDependency[];
  queues: AdminQueue[];
  /** Null when Redis, where heartbeats and ticks live, could not be read. */
  processes: AdminProcess[] | null;
  ticks: AdminTick[] | null;
}

// --- errors (#1240) --------------------------------------------------------

/** The periods the errors list offers, in hours. */
export const ADMIN_ERROR_PERIODS = [1, 24, 168, 720] as const;

/**
 * Repeats of one error in the period. The fingerprint is derived when read
 * (source + logger context + the message with ids, numbers and quoted values
 * folded), never stored, so changing the rule regroups history at once.
 */
export interface AdminErrorGroup {
  fingerprint: string;
  /** The newest occurrence: what the row shows and where it links. */
  latestId: string;
  message: string;
  /** The logged error's own message, on one line, when it says more than `message` (a catch-all's "Unhandled exception"). */
  detail: string | null;
  level: string;
  code: string | null;
  /** 'http' | 'job' | 'ws' | 'mcp' | 'cli' */
  source: string;
  /** The logger context (the class that logged it), when the call site had one. */
  context: string | null;
  route: string | null;
  /** Every process the group was seen in; null for a row written before processes were recorded. */
  processes: Array<OpsProcessKind | null>;
  count: number;
  workspaceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AdminErrorWorkspaceFacet {
  workspaceId: string;
  name: string;
  count: number;
}

export interface AdminErrorsResponse {
  groups: AdminErrorGroup[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
  /** Workspaces with errors in the period, most first: the workspace filter's options. */
  workspaces: AdminErrorWorkspaceFacet[];
  /** How long rows are kept (`OPS_EVENTS_RETENTION_DAYS`). */
  retentionDays: number;
  /** `OPS_SINK_ENABLED` on this API process. Off, an empty list means nothing was recorded, not nothing failed. */
  recording: boolean;
}

export interface AdminErrorOccurrence {
  id: string;
  createdAt: string;
  traceId: string;
  process: OpsProcessKind | null;
  workspaceId: string | null;
  workspaceName: string | null;
  route: string | null;
}

export interface AdminErrorEvent {
  id: string;
  createdAt: string;
  traceId: string;
  process: OpsProcessKind | null;
  source: string;
  level: string;
  code: string | null;
  message: string;
  context: string | null;
  route: string | null;
  durationMs: number | null;
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string | null;
  userEmail: string | null;
  /** The serialized error's stack, when one was logged. */
  stack: string | null;
  /** Everything the call site logged, the serialized error included. */
  fields: Record<string, unknown>;
}

export interface AdminErrorResponse {
  event: AdminErrorEvent;
  /** The same fingerprint across everything still kept. */
  group: { fingerprint: string; count: number; firstSeenAt: string; lastSeenAt: string };
  /** The group's newest occurrences, this one among them when recent. */
  recent: AdminErrorOccurrence[];
}
