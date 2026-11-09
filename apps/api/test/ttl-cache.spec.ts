import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttlCache } from '../src/common/ttl-cache.js';

describe('ttlCache', () => {
  afterEach(() => vi.useRealTimers());

  it('reuses a load within the TTL, reloads after it, and after delete()', async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1_000);
    let n = 0;
    const load = async () => ++n;
    expect(await cache.get('ws', load)).toBe(1);
    expect(await cache.get('ws', load)).toBe(1);
    expect(await cache.get('other', load)).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(await cache.get('ws', load)).toBe(3);
    cache.delete('ws');
    expect(await cache.get('ws', load)).toBe(4);
  });

  it('caches nothing when the load throws', async () => {
    const cache = ttlCache<string>(1_000);
    await expect(cache.get('ws', async () => Promise.reject(new Error('db down')))).rejects.toThrow('db down');
    expect(await cache.get('ws', async () => 'fresh')).toBe('fresh');
  });
});
