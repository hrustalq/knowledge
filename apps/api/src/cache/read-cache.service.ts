import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

/**
 * Every key family the read cache holds (#472, docs/architecture/10-caching.md),
 * with what invalidates it. **Scope-free answers only**: nothing that depends
 * on who asks — pages, trees, search results, lists — is ever cached here; PG
 * keeps the final say on visibility. Nothing that carries a credential either
 * (a resolved provider config holds a decrypted key).
 *
 * The cache is one Redis every process shares, so invalidation is a single
 * DEL at the one write site, reaching every API process and worker at once;
 * the TTL is only the backstop.
 */
export const READ_CACHE_FAMILIES = {
  /** A finalized revision's raw bytes. Immutable: a revision never changes. */
  content: { key: (revisionId: string) => `content:${revisionId}`, ttlMs: 24 * 3_600_000, invalidatedBy: 'nothing (immutable)' },
  /** A query's embedding in one embedding space. Immutable for that space. */
  embedding: {
    key: (signature: string, text: string) => `embedding:${signature}:${createHash('sha256').update(text).digest('hex')}`,
    ttlMs: 24 * 3_600_000,
    invalidatedBy: 'nothing (the signature names the space)',
  },
  /** The sparse knowledge-health settings row. */
  healthSettings: {
    key: () => 'health-settings',
    ttlMs: null,
    invalidatedBy: 'VerificationPolicyService.update',
  },
} as const;

/** `global` for an answer no workspace owns (an embedding of a query text). */
export type CacheNamespace = string | 'global';

/**
 * A small fail-open read cache over Redis (#472). Off unless
 * READ_CACHE_ENABLED, and then any Redis failure — down, slow, a bad value —
 * falls through to the source, so a read behaves exactly as without it.
 * Keys are `cache:{workspaceId|global}:{family key}`, each with a TTL.
 */
@Injectable()
export class ReadCache implements OnModuleDestroy {
  private readonly logger = new Logger(ReadCache.name);
  private readonly redis: Redis | null;
  private readonly defaultTtlMs: number;

  constructor(config: ConfigService<Env, true>) {
    this.defaultTtlMs = config.get('READ_CACHE_DEFAULT_TTL_MS', { infer: true });
    // Lazy, for the reason UrlTicketsService gives: the OpenAPI generator boots
    // AppModule with no Redis running. One retry and a short connect timeout,
    // so a dead Redis costs a read two seconds once, not forever.
    this.redis = config.get('READ_CACHE_ENABLED', { infer: true })
      ? new Redis(config.get('REDIS_URL', { infer: true }), { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 })
      : null;
    this.redis?.on('error', () => undefined);
  }

  /** The cached answer, or `load()`'s — which is stored for next time. */
  async wrap<T>(ns: CacheNamespace, key: string, load: () => Promise<T>, ttlMs: number | null = null): Promise<T> {
    if (!this.redis) return load();
    const full = `cache:${ns}:${key}`;
    try {
      const hit = await this.redis.get(full);
      if (hit !== null) return JSON.parse(hit) as T;
    } catch (e) {
      this.logger.debug(`read-cache miss on error (${full}): ${(e as Error).message}`);
      return load();
    }
    const value = await load();
    this.redis.set(full, JSON.stringify(value), 'PX', ttlMs ?? this.defaultTtlMs).catch(() => undefined);
    return value;
  }

  /** Drop one key, so the next read goes to the source. Never throws. */
  async invalidate(ns: CacheNamespace, key: string): Promise<void> {
    await this.redis?.del(`cache:${ns}:${key}`).catch(() => undefined);
  }

  /** Drop every key a workspace owns — its deletion (#479) must not leave its bytes behind. */
  async invalidateWorkspace(workspaceId: string): Promise<void> {
    if (!this.redis) return;
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', `cache:${workspaceId}:*`, 'COUNT', 500);
        if (keys.length) await this.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    } catch {
      // The TTL is the backstop.
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}
