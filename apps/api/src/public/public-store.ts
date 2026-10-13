import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

/** DI token for a substitute store (specs); production builds its own Redis client. */
export const PUBLIC_STORE = Symbol('PUBLIC_STORE');

/**
 * The Redis surface the anonymous routes need, small enough for a spec to fake:
 * fixed-window counters (`incr` + `pexpire` on the first hit), short-lived
 * session values (`set … PX`, `get`, `del`) and one-time codes (`getdel`,
 * which reads and spends a value in one step, so a code works once).
 */
export interface PublicKeyValueStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

/**
 * One Redis client for everything under /v1/public (docs/features/43), opened
 * lazily for the reason `UrlTicketsService` gives: the OpenAPI generator boots
 * AppModule with no Redis running.
 */
@Injectable()
export class PublicStore implements OnModuleDestroy {
  readonly kv: PublicKeyValueStore & { disconnect?: () => void };

  constructor(config: ConfigService<Env, true>, @Optional() @Inject(PUBLIC_STORE) store?: PublicKeyValueStore) {
    this.kv =
      store ??
      new Redis(config.get('REDIS_URL', { infer: true }), {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
      });
  }

  onModuleDestroy(): void {
    this.kv.disconnect?.();
  }
}
