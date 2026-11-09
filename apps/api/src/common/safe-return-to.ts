/**
 * A return path that is echoed into a redirect must be a path on our own web
 * app and nothing else. Anything absolute, protocol-relative (`//evil`) or
 * absent collapses to `fallback` — an open redirect here would be handed out
 * by a URL that looks like ours. So does any backslash (browsers read `\` as
 * `/`, so `/\evil` is `//evil`) and any whitespace or control character
 * (browsers drop a tab or newline from a URL, so `/<tab>/evil` is too).
 *
 * The one rule for the GitHub and Figma connector callbacks, SSO sign-in
 * (#75) and a published site's session route.
 */
export function safeReturnTo(raw: string | null | undefined, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return fallback;
  return raw;
}
