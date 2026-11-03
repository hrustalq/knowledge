/**
 * One localStorage key holding JSON, for per-viewer state such as a wizard's
 * persisted snapshot. Every access is guarded: a private window, cleared site
 * data or SSR (no `localStorage`) reads as "nothing stored" and a failed write
 * is dropped, so storage can never block the flow it remembers.
 */
export function storedJson<T>(key: string) {
  return {
    load(): T | undefined {
      try {
        const raw = localStorage.getItem(key)
        return raw ? (JSON.parse(raw) as T) : undefined
      } catch {
        return undefined
      }
    },
    save(value: T): void {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* storage unavailable */
      }
    },
    clear(): void {
      try {
        localStorage.removeItem(key)
      } catch {
        /* storage unavailable */
      }
    },
  }
}
