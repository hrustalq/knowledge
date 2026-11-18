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
