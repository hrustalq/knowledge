/**
 * A per-key memo of an async read, kept for `ttlMs`.
 *
 * Process-local on purpose: a write drops this process's entry with
 * `delete()`, and every other process (the worker, a second API) catches up
 * within one TTL. A failed load caches nothing.
 */
export function ttlCache<V>(ttlMs: number) {
  const entries = new Map<string, { at: number; value: V }>();
  return {
    async get(key: string, load: () => Promise<V>): Promise<V> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const value = await load();
      entries.set(key, { at: Date.now(), value });
      return value;
    },
    delete(key: string): void {
      entries.delete(key);
    },
    clear(): void {
      entries.clear();
    },
  };
}
