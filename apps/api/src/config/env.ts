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

  /** Phase 5 auth: 'none' = dev principal with full access (Phase 0-4 flows keep working); 'api-key' = Bearer key lookup against users.api_key_hash. */
  AUTH_MODE: z.enum(['none', 'api-key']).default('none'),

  /** Phase 5 optional BM25 layer (plan.md §11) — 'none' keeps search vector-only. */
  FULLTEXT_PROVIDER: z.enum(['none', 'opensearch']).default('none'),
  OPENSEARCH_URL: z.string().optional().default('http://localhost:9200'),
  OPENSEARCH_INDEX: z.string().optional().default('knowledge-chunks'),

  /** Phase 5 stale-doc detection & reindex scheduling (worker sweeper). */
  STALE_SWEEP_ENABLED: z.coerce.boolean().default(true),
  STALE_INDEXING_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
  STALE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),

  /** Phase 5 trusted-operator graph queries: hard row cap per call. */
  GRAPH_QUERY_MAX_ROWS: z.coerce.number().int().positive().max(1000).default(200),
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
