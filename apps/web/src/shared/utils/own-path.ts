/** A return path from the query string, if it stays on this app. */
export function ownPath(raw: unknown, fallback = '/documents'): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : fallback
}
