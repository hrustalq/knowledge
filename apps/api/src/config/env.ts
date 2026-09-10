import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

  ARCADE_URL: z.string().min(1),
  ARCADE_DB: z.string().min(1),
  ARCADE_USER: z.string().min(1),
  ARCADE_PASSWORD: z.string().min(1),

  EMBEDDINGS_PROVIDER: z.enum(['stub', 'openai-compatible']).default('stub'),
  EMBEDDINGS_BASE_URL: z.string().optional().default(''),
  EMBEDDINGS_MODEL: z.string().optional().default(''),
  EMBEDDINGS_API_KEY: z.string().optional().default(''),
  EMBEDDINGS_DIM: z.coerce.number().default(384),

  /** Phase 4 LLM relation extraction — 'none' keeps the pipeline dependency-free. */
  EXTRACTOR_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  EXTRACTOR_BASE_URL: z.string().optional().default(''),
  EXTRACTOR_MODEL: z.string().optional().default(''),
  EXTRACTOR_API_KEY: z.string().optional().default(''),
  EXTRACTOR_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.5),
  EXTRACTOR_MAX_CHUNKS: z.coerce.number().int().positive().default(20),

  /** Phase 5 auth: 'none' = dev principal with full access (Phase 0-4 flows keep working); 'api-key' = Bearer auth (kn_ API keys AND ks_ login session tokens). */
  AUTH_MODE: z.enum(['none', 'api-key']).default('none'),
  /** Auth flow: login session lifetime. */
  AUTH_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(720),
  /** Auth flow: password-reset token lifetime. */
  AUTH_RESET_TTL_MIN: z.coerce.number().int().positive().default(30),
  /** Auth flow: allow self-service POST /v1/auth/signup. */
  AUTH_SIGNUP_ENABLED: z.coerce.boolean().default(true),
  /** Workspace new signups auto-join (empty disables). Defaults to the demo workspace. */
  AUTH_DEFAULT_WORKSPACE_ID: z.string().default('11111111-1111-4111-8111-111111111111'),
  AUTH_DEFAULT_ROLE: z.enum(['viewer', 'editor', 'admin']).default('viewer'),
  /** Public base URL of the web app — used in password-reset links (logged; no mailer yet). */
  WEB_BASE_URL: z.string().default('http://localhost:5173'),

  /** Phase 5 optional BM25 layer (plan.md §11) — 'none' keeps search vector-only. */
  FULLTEXT_PROVIDER: z.enum(['none', 'opensearch']).default('none'),
  OPENSEARCH_URL: z.string().optional().default('http://localhost:9200'),
  OPENSEARCH_INDEX: z.string().optional().default('knowledge-chunks'),

  /** Phase 5 stale-doc detection & reindex scheduling (worker sweeper). */
  STALE_SWEEP_ENABLED: z.coerce.boolean().default(true),
  // Background agent schedules (docs/features/20). Off by default: the failure
  // mode of unattended AI is an avalanche, not a slow queue.
  AGENT_SCHEDULE_ENABLED: z.coerce.boolean().default(false),
  STALE_INDEXING_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
  STALE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /**
   * Feature 09 AI assistant (docs/features/09) — 'none' disables the LLM endpoints.
   * All non-none providers use the official `openai` SDK. `deepseek` and
   * `gen-api` are named shorthands that only pre-fill BASE_URL/MODEL from
   * PROVIDER_DEFAULTS — https://api.deepseek.com and
   * https://proxy.gen-api.ru/v1 respectively. gen-api.ru is an aggregator, so
   * one credential reaches GPT, Claude and Gemini models by id.
   */
  ASSISTANT_PROVIDER: z.enum(['none', 'openai-compatible', 'deepseek', 'gen-api']).default('none'),
  ASSISTANT_BASE_URL: z.string().optional().default(''),
  ASSISTANT_MODEL: z.string().optional().default(''),
  ASSISTANT_API_KEY: z.string().optional().default(''),
  /** Tool harness: max tool executions per /v1/assistant/ask request (0 = plain chat). */
  ASSISTANT_MAX_TOOL_CALLS: z.coerce.number().int().min(0).max(16).default(6),
  /** Upstream request timeout for the assistant provider. */
  ASSISTANT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Feature 12 AI settings: AES-256-GCM key (base64, 32 bytes) for provider
   * credentials stored in ai_settings/ai_plugins. Empty disables secret WRITES
   * (everything else keeps working) rather than failing boot — same fail-soft
   * spirit as ASSISTANT_PROVIDER=none. Generate: openssl rand -base64 32
   */
  SETTINGS_ENCRYPTION_KEY: z.string().optional().default(''),
  /** Feature 12 plugins: allow MCP server URLs on private/loopback ranges (self-hosted). */
  AI_PLUGINS_ALLOW_PRIVATE_URLS: z.coerce.boolean().default(false),

  /**
   * Web research (docs/features/25): the CEILING on how much of the open web
   * the assistant may reach, not a default.
   *
   * `ai_settings.web_access_mode` is clamped to this rather than inheriting it,
   * because a workspace admin must not be able to switch on the open web in a
   * deployment where that was decided against. Feature 20 already committed to
   * the rule: settings intersect, never union.
   *
   * `off` keeps every existing deployment byte-identical — the two web tools
   * are not offered to the model at all.
   */
  WEB_ACCESS_MODE: z.enum(['off', 'allowlist', 'open']).default('off'),

  /**
   * SearXNG JSON endpoint, e.g. `http://searxng:8080`. Unset means fetching a
   * named URL still works and searching does not.
   *
   * Deliberately a URL rather than a `WEB_SEARCH_PROVIDER` enum: there is one
   * backend, and an enum's `none` would mean "the tools do not exist", which
   * WEB_ACCESS_MODE=off already says in the setting that also says it to the
   * workspace. The interface arrives with the second backend, shaped by what
   * the two actually differ on.
   *
   * NOTE: SearXNG's JSON API is off by default — `formats: [json]` has to be
   * set in its settings.yml or every query comes back as HTML.
   */
  WEB_SEARCH_URL: z.string().optional().default(''),

  /** Allow web targets on private/loopback ranges (self-hosted SearXNG, intranet). */
  WEB_ALLOW_PRIVATE_URLS: z.coerce.boolean().default(false),

  /** Hard cap on a fetched page before extraction, so one huge URL cannot exhaust the process. */
  WEB_FETCH_MAX_BYTES: z.coerce.number().int().positive().default(2_000_000),

  /** Upstream timeout for one search or one page fetch. */
  WEB_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /** Feature 04: max dependent documents re-indexed per indexed revision (0 disables). */
  DEPENDENT_REINDEX_MAX: z.coerce.number().int().min(0).default(20),

  /**
   * Dynamic workflows (docs/features/17): how many auto-started runs one
   * workspace may have in flight. The cap exists because the failure mode of an
   * event trigger is an LLM avalanche, not a slow queue.
   */
  WORKFLOW_AUTOSTART_MAX_ACTIVE: z.coerce.number().int().min(0).default(5),

  /**
   * How long a workflow node may sit claimed (`running`) before the sweeper
   * assumes the worker that took it died and returns it to the queue.
   * Generous by default: a drafting step with tools legitimately takes minutes,
   * and re-queueing a live step means paying for the model call twice.
   */
  WORKFLOW_NODE_STALE_MS: z.coerce.number().int().min(1000).default(15 * 60_000),

  /** Merge gating: approvals required to merge (the author's own approval never counts; 0 disables the gate). */
  MR_REQUIRED_APPROVALS: z.coerce.number().int().min(0).default(1),

  /** Phase 5 trusted-operator graph queries: hard row cap per call. */
  GRAPH_QUERY_MAX_ROWS: z.coerce.number().int().positive().max(1000).default(200),

  /** Rich-editor page attachments: hard per-file ceiling (bytes), enforced at presign and again on confirm. */
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),

  /**
   * Document import (docs/features/16). The ceiling is larger than an
   * attachment's because the thing being uploaded is a whole book of a PDF, not
   * a screenshot; it is enforced at presign and again from the bucket's own
   * HEAD, so a client that lies about `sizeBytes` still cannot get past it.
   */
  IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(52_428_800),
  /** Wall-clock ceiling for one parse, so a pathological file fails instead of pinning a worker. */
  IMPORT_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Vision-OCR page ceiling — bounds the spend a single scanned PDF can incur. */
  IMPORT_OCR_MAX_PAGES: z.coerce.number().int().positive().default(20),

  /**
   * Connectors (docs/features/19). Allow connector base URLs and git remotes on
   * private/loopback ranges — an on-prem Confluence or a self-hosted GitLab is a
   * legitimate target, but the default refuses them because a URL typed into a
   * settings form is also the classic SSRF shape. Mirrors AI_PLUGINS_ALLOW_PRIVATE_URLS.
   */
  CONNECTOR_ALLOW_PRIVATE_URLS: z.coerce.boolean().default(false),
  /** Items one sync run will touch, so a 50k-page space cannot pin a worker forever. */
  CONNECTOR_SYNC_MAX_ITEMS: z.coerce.number().int().positive().default(1_000),
  /** Wall-clock ceiling for one sync run. */
  CONNECTOR_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Worker-side schedule sweeper for connectors with syncIntervalMinutes set. */
  CONNECTOR_SCHEDULE_ENABLED: z.coerce.boolean().default(true),

  /** Live tracked-entity updates over WebSocket (/v1/events/ws). */
  LIVE_WS_ENABLED: z.coerce.boolean().default(true),
  /** Server-side tracking configuration: comma-separated event types (exact or 'prefix.*'); '*' broadcasts everything. */
  LIVE_TRACKED_EVENTS: z.string().default('*'),
  /** Max concurrent workspace subscriptions per socket. */
  LIVE_WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().max(64).default(8),

  /**
   * Interface + API language (docs/features/18). Also the fallback whenever a
   * request carries no ?lang=, no kn_lang cookie and no usable Accept-Language,
   * and the language worker-generated prose defaults to. Must keep a default:
   * scripts/generate-openapi.main.ts runs this validation with no infra.
   */
  I18N_DEFAULT_LOCALE: z.enum(['en', 'ru']).default('en'),
});

export type Env = z.infer<typeof envSchema>;

/** Fail-fast env validation, plugged into @nestjs/config `validate`. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return parsed.data;
}
