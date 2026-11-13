import type { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Which email domains an identity provider may speak for (GHSA-xj6f-x636-xrx8).
 *
 * `allowedDomains` is what a workspace admin typed, and anyone can be a
 * workspace admin of a workspace they created. So a domain on the list counts
 * only when the provider's workspace proved it in DNS (a verified
 * `sso_domains` row, the proof `ScimService.domainAuthority` already reads),
 * or when the provider is platform-wide: only a platform admin may change that
 * list. Sign-in, the save path and the admin view all read this one predicate.
 */

type ProviderDomains = { workspaceId: string; platformWide: boolean; allowedDomains: string[] };

/** The domains on the provider's list it may not assert yet: they need DNS proof in its workspace. */
export async function unprovenDomains(prisma: PrismaService, provider: ProviderDomains, domains = provider.allowedDomains): Promise<string[]> {
  if (provider.platformWide || domains.length === 0) return [];
  const rows = await prisma.ssoDomain.findMany({
    where: { workspaceId: provider.workspaceId, domain: { in: domains }, verifiedAt: { not: null } },
    select: { domain: true },
  });
  const proven = new Set(rows.map((r) => r.domain));
  return domains.filter((d) => !proven.has(d));
}

/** Whether the provider may assert an address on `domain`: listed, and proven. */
export async function speaksFor(prisma: PrismaService, provider: ProviderDomains, domain: string): Promise<boolean> {
  if (!provider.allowedDomains.includes(domain)) return false;
  return (await unprovenDomains(prisma, provider, [domain])).length === 0;
}
