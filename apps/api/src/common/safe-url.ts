import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { t } from '../i18n/t.js';

/**
 * SSRF guard for URLs an admin types into a settings form.
 *
 * Extracted from the AI plugin service (docs/features/12) when connectors
 * (docs/features/19) needed exactly the same check for Confluence/Jira/Notion
 * base URLs and git remotes. Both callers pass their own message keys, because
 * "that is not a URL" reads differently next to a plugin field and a repository
 * field, and Russian needs the noun declined either way.
 *
 * An admin pointing at an internal service is a legitimate deployment, and it
 * is also the classic SSRF shape — so private and loopback targets are refused
 * unless the caller's allow-private flag says this is a self-hosted setup where
 * that is the point. The DNS name is resolved rather than the literal host
 * trusted, so `internal.example.com` pointing at 127.0.0.1 is caught too.
 */
export interface SafeUrlMessageKeys {
  invalid: string;
  notHttps: string;
  unresolved: string;
  private: string;
}

// ponytail: same TOCTOU as SourcePolicyService.resolvesPrivate — the name is
// resolved here and again by whatever client dials it, so DNS rebinding slips
// between the two. ceiling: catches a static record pointing inward, not a
// record that changes between the check and the call. upgrade: fix both callers
// at once with a shared IP-pinning dispatcher; see the marker in
// source-policy.service.ts.
export async function assertSafeExternalUrl(
  raw: string,
  allowPrivate: boolean,
  keys: SafeUrlMessageKeys,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(t(keys.invalid));
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new BadRequestException(t(keys.notHttps));
  }
  if (allowPrivate) return;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new BadRequestException(t(keys.unresolved, { host }));
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new BadRequestException(t(keys.private, { address }));
  }
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fe80') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:10.0.0.1) — fall through to the v4 checks.
    const mapped = v6.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (!mapped) return false;
    address = mapped[1];
  }
  const [a, b] = address.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}
