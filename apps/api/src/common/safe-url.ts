import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

/**
 * Admin-time validation only. This resolves the name to decide, and whatever
 * dials it later resolves it again — so on its own it never closed the DNS
 * rebinding window, and no amount of checking here could: a check that finishes
 * before the socket opens is by construction a different resolution.
 *
 * The runtime half now lives in `common/safe-fetch.ts`, which validates inside
 * the connection's own lookup. This stays because a settings form needs to say
 * "that host is internal" in words, immediately, rather than failing a request
 * an hour later.
 */
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

/**
 * Everything that is not the public internet. `BlockList` compares parsed
 * addresses, so no spelling of one can slip past, and it checks an IPv4-mapped
 * IPv6 address against the IPv4 rules. Forms that embed an IPv4 address some
 * other way (NAT64, the deprecated `::a.b.c.d`) are refused whole.
 */
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, incl. cloud metadata
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return PRIVATE_ADDRESSES.check(address, family === 6 ? 'ipv6' : 'ipv4');
}
