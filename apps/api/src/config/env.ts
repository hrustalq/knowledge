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
  STALE_INDEXING_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
  STALE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /** Feature 09 AI assistant (docs/features/09) — 'none' disables the LLM endpoints. */
  ASSISTANT_PROVIDER: z.enum(['none', 'openai-compatible']).default('none'),
  ASSISTANT_BASE_URL: z.string().optional().default(''),
  ASSISTANT_MODEL: z.string().optional().default(''),
  ASSISTANT_API_KEY: z.string().optional().default(''),

  /** Feature 04: max dependent documents re-indexed per indexed revision (0 disables). */
  DEPENDENT_REINDEX_MAX: z.coerce.number().int().min(0).default(20),

  /** Phase 5 trusted-operator graph queries: hard row cap per call. */
  GRAPH_QUERY_MAX_ROWS: z.coerce.number().int().positive().max(1000).default(200),

  /** Live tracked-entity updates over WebSocket (/v1/events/ws). */
  LIVE_WS_ENABLED: z.coerce.boolean().default(true),
  /** Server-side tracking configuration: comma-separated event types (exact or 'prefix.*'); '*' broadcasts everything. */
  LIVE_TRACKED_EVENTS: z.string().default('*'),
  /** Max concurrent workspace subscriptions per socket. */
  LIVE_WS_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().max(64).default(8),
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
