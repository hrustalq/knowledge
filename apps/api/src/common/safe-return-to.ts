/**
 * A return path that is echoed into a redirect must be a path on our own web
 * app and nothing else. Anything absolute, protocol-relative (`//evil`, and
 * `/\evil`, which browsers read the same way) or absent collapses to
 * `fallback` — an open redirect here would be handed out by a URL that looks
 * like ours.
 *
 * Lifted from the GitHub connector callback when SSO sign-in (#75) needed the
 * same rule for the page a login started from.
 */
export function safeReturnTo(raw: string | null | undefined, fallback: string): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  return raw;
}
