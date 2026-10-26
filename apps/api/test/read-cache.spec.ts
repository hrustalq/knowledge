import { describe, expect, it, vi } from 'vitest';
import { ReadCache, READ_CACHE_FAMILIES } from '../src/cache/read-cache.service.js';

function config(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] } as never;
}

/** A Map behind the three commands the cache uses. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    del: vi.fn(async (...keys: string[]) => keys.forEach((k) => store.delete(k))),
    scan: vi.fn(async (_c: string, _m: string, pattern: string) => [
      '0',
      [...store.keys()].filter((k) => k.startsWith(pattern.replace('*', ''))),
    ]),
    on: () => undefined,
    disconnect: () => undefined,
  };
}

function cacheWith(redis: ReturnType<typeof fakeRedis>) {
  const cache = new ReadCache(config({ READ_CACHE_ENABLED: false, READ_CACHE_DEFAULT_TTL_MS: 1000 }));
  (cache as unknown as { redis: unknown }).redis = redis;
  return cache;
}

describe('ReadCache (#472)', () => {
  it('off: every read goes to the source', async () => {
    const cache = new ReadCache(config({ READ_CACHE_ENABLED: false, READ_CACHE_DEFAULT_TTL_MS: 1000 }));
    const load = vi.fn(async () => 1);
    await cache.wrap('ws', 'k', load);
    await cache.wrap('ws', 'k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a hit skips the source; an invalidation sends the next read back to it', async () => {
    const redis = fakeRedis();
    const cache = cacheWith(redis);
    const load = vi.fn().mockResolvedValueOnce({ v: 1 }).mockResolvedValueOnce({ v: 2 });
    expect(await cache.wrap('ws', 'k', load)).toEqual({ v: 1 });
    await vi.waitFor(() => expect(redis.store.has('cache:ws:k')).toBe(true));
    expect(await cache.wrap('ws', 'k', load)).toEqual({ v: 1 });
    expect(load).toHaveBeenCalledTimes(1);
    await cache.invalidate('ws', 'k');
    expect(await cache.wrap('ws', 'k', load)).toEqual({ v: 2 });
  });

  it('every key carries a TTL', async () => {
    const redis = fakeRedis();
    await cacheWith(redis).wrap('ws', 'k', async () => 1);
    expect(redis.set).toHaveBeenCalledWith('cache:ws:k', '1', 'PX', 1000);
  });

  it('Redis down: the read still answers, from the source', async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await cacheWith(redis).wrap('ws', 'k', async () => 'source')).toBe('source');
  });

  it("a workspace's deletion drops its keys and nobody else's", async () => {
    const redis = fakeRedis();
    redis.store.set('cache:ws1:content:r1', '"a"').set('cache:ws2:content:r2', '"b"').set('cache:global:embedding:x', '[]');
    await cacheWith(redis).invalidateWorkspace('ws1');
    expect([...redis.store.keys()]).toEqual(['cache:ws2:content:r2', 'cache:global:embedding:x']);
  });

  it('holds only the reviewed, scope-free families', () => {
    // A new family is a review: it must answer the same for every caller (no
    // AccessScope, no page list, no search result) and carry no credential.
    // Add it here with that argument in the PR, or do not add it.
    expect(Object.keys(READ_CACHE_FAMILIES).sort()).toEqual(['content', 'embedding', 'healthSettings']);
  });
});
