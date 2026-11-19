/** A return path from the query string, if it stays on this app. */
export function ownPath(raw: unknown, fallback = '/documents'): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : fallback
}

/**
 * A path another app on this host serves: the admin console (#1236), which
 * Caddy routes to its own container. The router cannot push there — it would
 * draw this app's not-found page — so a return path into it is a full load.
 */
export function isOtherApp(path: string): boolean {
  return /^\/admin(?:[/?#]|$)/.test(path)
}
