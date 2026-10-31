import { ConnectorNetworkError, ConnectorRequestError } from './connector.types.js';

/**
 * How a `web` source's fetch failed (#674), read by the staging step that
 * decides whether to retry, count toward archiving, or fail the sync. A leaf
 * beside the adapter so callers need not reach the adapter itself.
 */

/** Worth trying again later: unreachable, timed out, rate-limited or a server error. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ConnectorNetworkError) return true;
  if (err instanceof ConnectorRequestError) return err.status === 429 || err.status === 408 || err.status >= 500;
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** 404 or 410: the source says it is gone. */
export function isGone(err: unknown): boolean {
  return err instanceof ConnectorRequestError && (err.status === 404 || err.status === 410);
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or 0 when absent or unreadable. */
export function retryAfterMs(err: unknown, now = Date.now()): number {
  const raw = err instanceof ConnectorRequestError ? err.retryAfter : null;
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

