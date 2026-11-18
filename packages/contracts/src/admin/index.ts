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
