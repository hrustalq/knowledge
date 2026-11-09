import { Injectable } from '@nestjs/common';
import { SharedRedis } from '../redis/shared-redis.js';

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
 * The shared Redis client, narrowed to what everything under /v1/public
 * (docs/features/43) uses. Provided by `RedisModule` only.
 */
@Injectable()
export class PublicStore {
  readonly kv: PublicKeyValueStore;

  constructor(redis: SharedRedis) {
    this.kv = redis.client;
  }
}
