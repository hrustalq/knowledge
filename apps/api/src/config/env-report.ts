import type { AdminConfigEntry, EnvGroup } from '@knowledge/contracts';
import { envSchema, type Env } from './env.js';

/**
 * The admin console's view of the resolved environment (#1237).
 *
 * **Secrets are one list.** A key here never has its value returned, only
 * whether it is set. `env-report.spec.ts` fails when a key whose name looks
 * like a credential (`SECRET`, `TOKEN`, `KEY`, `PASS`) is in neither this list
 * nor `NOT_SECRET_ENV_KEYS`, so a new credential cannot ship unclassified. The
 * DSNs are listed too: a password can sit in a query string as well as in the
 * userinfo, which `stripUserinfo` removes from every other URL anyway.
 */
export const SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  'DATABASE_URL',
  'REDIS_URL',
  'MAIL_SMTP_URL',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'ARCADE_PASSWORD',
  'EMBEDDINGS_API_KEY',
  'EXTRACTOR_API_KEY',
  'ASSISTANT_API_KEY',
  'TRANSCRIPTION_API_KEY',
  'MEMORY_RERANKER_API_KEY',
  'MAIL_SMTP_PASS',
  'ANALYTICS_READER_SECRET',
  'SETTINGS_ENCRYPTION_KEY',
  'FIGMA_OAUTH_CLIENT_SECRET',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_WEBHOOK_SECRET',
]);

/** Names that look like a credential and are not one: shown with their value. */
export const NOT_SECRET_ENV_KEYS: ReadonlySet<string> = new Set([
  // A boolean: whether reset/verify tokens are echoed to the caller (refused in production).
  'AUTH_ECHO_TOKENS',
  // A boolean: whether password sign-in is offered.
  'AUTH_PASSWORD_LOGIN_ENABLED',
  // A rate: captures per API key per hour.
  'CAPTURE_PER_KEY_PER_HOUR',
]);

/** What `env-report.spec.ts` holds every key name to. */
export const CREDENTIAL_NAME = /SECRET|TOKEN|KEY|PASS/;

/**
 * Group by name prefix; the longest prefix wins (`AI_READABLE_` is publishing,
 * `AI_` is AI). A key no prefix claims shows under `other`.
 */
const GROUP_PREFIXES: Record<string, EnvGroup> = {
  NODE_ENV: 'core',
  PORT: 'core',
  HTTP_: 'core',
  LOG_: 'core',
  OPS_: 'core',
  I18N_: 'core',
  WEB_BASE_URL: 'core',
  WEB_INTERNAL_URL: 'core',
  API_PUBLIC_URL: 'core',
  SETTINGS_ENCRYPTION_KEY: 'core',
  FETCH_MAX_BYTES: 'core',

  DATABASE_: 'storage',
  REDIS_: 'storage',
  S3_: 'storage',
  ARCADE_: 'storage',

  AUTH_: 'auth',
  ACL_: 'auth',
  ACCESS_REQUEST_: 'auth',

  MAIL_: 'mail',

  ASSISTANT_: 'ai',
  EMBEDDINGS_: 'ai',
  EXTRACTOR_: 'ai',
  AI_: 'ai',
  DECISION_: 'ai',
  TRANSCRIPTION_: 'ai',
  ANSWER_: 'ai',
  WEB_ACCESS_: 'ai',
  WEB_SEARCH_: 'ai',
  WEB_ALLOW_: 'ai',
  WEB_FETCH_: 'ai',
  WEB_TIMEOUT_: 'ai',
  IMAGE_PROXY_: 'ai',

  AGENT_: 'agents',
  LEARNER_: 'agents',
  CAPTURE_: 'agents',
  KNOWLEDGE_ISSUE_: 'agents',
  COVERAGE_: 'agents',
  REPO_GUIDANCE_: 'agents',
  WORKFLOW_: 'agents',
  CONTRADICTION_: 'agents',

  MEMORY_: 'memory',

  STALE_: 'ingestion',
  DEPENDENT_: 'ingestion',
  IMPORT_: 'ingestion',
  REVISION_: 'ingestion',
  ATTACHMENT_: 'ingestion',
  ARCHIVE_: 'ingestion',
  MR_: 'ingestion',
  API_SPEC_: 'ingestion',

  FULLTEXT_: 'search',
  OPENSEARCH_: 'search',
  SEARCH_: 'search',
  GRAPH_QUERY_: 'search',
  COMMUNITY_: 'search',

  VERIFICATION_: 'quality',
  PAGE_INACTIVE_: 'quality',
  EMPTY_PAGE_: 'quality',
  STYLEGUIDE_: 'quality',
  LINT_: 'quality',
  STYLE_: 'quality',
  QUALITY_: 'quality',
  ANALYTICS_: 'quality',
  API_TRY_: 'quality',
  API_TEST_: 'quality',

  PUBLIC_: 'publishing',
  SHARE_: 'publishing',
  SITE_: 'publishing',
  PUBLISH_: 'publishing',
  PUBLISHING_: 'publishing',
  AI_READABLE_: 'publishing',
  LLMS_: 'publishing',
  EXPORT_: 'publishing',
  GOTENBERG_: 'publishing',
  EMBED_: 'publishing',

  CONNECTOR_: 'connectors',
  GITHUB_: 'connectors',
  FIGMA_: 'connectors',
  PLAUD_: 'connectors',
  WEB_SOURCE: 'connectors',
  WORK_ITEM_: 'connectors',
  CODE_: 'connectors',
  WIKI_: 'connectors',
  CHANGELOG_: 'connectors',
  GIT_: 'connectors',

  CHAT_: 'chat',
  TELEGRAM_: 'chat',
  HARVEST_: 'chat',

  MEMO_: 'memos',

  LIVE_: 'live',
  COLLAB_: 'live',
  READ_CACHE_: 'live',
};

export function envGroupOf(key: string): EnvGroup {
  let best = '';
  for (const prefix of Object.keys(GROUP_PREFIXES)) {
    if (key.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  return best ? GROUP_PREFIXES[best]! : 'other';
}

/** `scheme://user:pass@host` → `scheme://host`; anything else as it was. */
function stripUserinfo(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value.replace(/\/\/[^/]*@/, '//');
  }
}

function shown(value: unknown): AdminConfigEntry['value'] {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  // Every key is a string, number or boolean today; a transform that yields more still never leaks a URL credential.
  return stripUserinfo(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * Every schema key, in schema order: its group, where its value came from
 * (`provided` = the keys the environment set, as `validateEnv` saw them), and
 * the value, or only `set` for a secret.
 */
export function envReport(env: Env, provided: ReadonlySet<string>): AdminConfigEntry[] {
  return Object.keys(envSchema.shape).map((key) => {
    const value = (env as Record<string, unknown>)[key];
    const secret = SECRET_ENV_KEYS.has(key);
    return {
      key,
      group: envGroupOf(key),
      source: provided.has(key) ? 'env' : 'default',
      secret,
      set: value !== undefined && value !== null && value !== '',
      value: secret ? null : shown(value),
    };
  });
}
