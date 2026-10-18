import { isIP } from 'node:net';

/** IPv4 private, loopback, link-local and CGNAT ranges, and their IPv6 equivalents. */
function isInternal(address: string): boolean {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

/**
 * The address a request came from — what a public route is counted against,
 * and what a session or an audit row records.
 *
 * Nothing reaches the API from the internet directly: Caddy proxies `/api/*`
 * and the web SSR calls it over the internal network, both from a private
 * address, both carrying the visitor in X-Forwarded-For (see Caddyfile and
 * apps/web/server.js). So the header is believed only when the peer is
 * internal, and then its first entry is the visitor. A peer on a public
 * address is counted as itself, whatever header it sends.
 */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> }): string {
  const peer = req.socket?.remoteAddress ?? req.ip ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (isInternal(peer) && typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0].trim();
    if (isIP(first)) return first;
  }
  return peer;
}

/** What a session and an audit row remember about the request that made them. */
export interface RequestMeta {
  ip: string;
  userAgent: string | null;
}

export function requestMeta(req: Parameters<typeof clientIp>[0]): RequestMeta {
  const ua = req.headers['user-agent'];
  return { ip: clientIp(req), userAgent: typeof ua === 'string' && ua ? ua.slice(0, 512) : null };
}
