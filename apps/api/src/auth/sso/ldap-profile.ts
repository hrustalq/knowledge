import type { IdentityProvider } from '@prisma/client';
import { Filter } from 'ldapts';
import { LDAP_DEFAULT_USER_FILTER, type LdapProviderConfig } from '@knowledge/contracts';
import { groupsFrom, str, type ClaimsResult } from './oidc-claims.js';

export function ldapConfigOf(provider: Pick<IdentityProvider, 'config'>): LdapProviderConfig {
  const raw = (provider.config ?? {}) as Record<string, unknown>;
  return {
    url: str(raw.url) ?? '',
    startTls: raw.startTls === true,
    bindDn: str(raw.bindDn),
    baseDn: str(raw.baseDn) ?? '',
    userFilter: str(raw.userFilter),
    emailAttribute: str(raw.emailAttribute),
    nameAttribute: str(raw.nameAttribute),
  };
}

/** Why a directory URL may not be used, or null. Plain `ldap://` needs StartTLS unless the instance allows clear text. */
export function ldapUrlProblem(
  config: Pick<LdapProviderConfig, 'url' | 'startTls'>,
  allowInsecure: boolean,
): 'invalid' | 'insecure' | null {
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    return 'invalid';
  }
  // proto/host/port only: a path, query or credentials would mean something else to every other LDAP tool.
  if (!['ldap:', 'ldaps:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || (url.pathname && url.pathname !== '/')) {
    return 'invalid';
  }
  if (url.protocol === 'ldap:' && !config.startTls && !allowInsecure) return 'insecure';
  return null;
}

/** The typed username inside the provider's filter, every occurrence escaped (RFC 4515). */
export function userFilterFor(template: string | null, username: string): string {
  return (template ?? LDAP_DEFAULT_USER_FILTER).replaceAll('{username}', Filter.escape(username));
}

/** A filter an admin may save: it names the person, and its parentheses balance. */
export function userFilterValid(template: string): boolean {
  if (!template.includes('{username}') || !template.startsWith('(') || !template.endsWith(')')) return false;
  let depth = 0;
  for (const ch of template.replace(/\\[0-9a-fA-F]{2}/g, '')) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

type Entry = Record<string, unknown>;

const first = (v: unknown): string | null => str(Array.isArray(v) ? v.find((x) => typeof x === 'string') : v);

/** AD's objectGUID is 16 bytes, the first three groups little-endian: as AD tools print it. */
function guidOf(v: unknown): string | null {
  const buf = Array.isArray(v) ? v[0] : v;
  if (!Buffer.isBuffer(buf) || buf.length !== 16) return null;
  const h = (i: number) => buf[i].toString(16).padStart(2, '0');
  const hex = (idx: number[]) => idx.map(h).join('');
  return `${hex([3, 2, 1, 0])}-${hex([5, 4])}-${hex([7, 6])}-${hex([8, 9])}-${hex([10, 11, 12, 13, 14, 15])}`;
}

/**
 * The directory entry a person bound as → the identity every SSO kind feeds
 * `SsoLoginService`.
 *
 * The subject is the entry's immutable id (OpenLDAP `entryUUID`, AD
 * `objectGUID`), never its DN: a DN changes when someone is renamed or moved
 * between OUs, and a subject that changes links a fresh identity — or, worse,
 * a recycled DN links the next person to the last one's account.
 *
 * Like a SAML assertion, a directory has no `email_verified`: the address
 * counts as vouched for because the directory's admin controls it, and the
 * provider's `allowedDomains` is what keeps it from speaking for another
 * organisation's mailbox.
 */
export function identityFromLdapEntry(entry: Entry, config: LdapProviderConfig, groupsAttribute: string): ClaimsResult {
  const subject = first(entry.entryUUID)?.toLowerCase() ?? guidOf(entry.objectGUID);
  if (!subject) return { ok: false, error: 'id-token-invalid', reason: 'entry has neither entryUUID nor objectGUID' };
  const email = first(entry[config.emailAttribute ?? 'mail'])?.toLowerCase() ?? null;
  const name = config.nameAttribute ? first(entry[config.nameAttribute]) : (first(entry.displayName) ?? first(entry.cn));
  return {
    ok: true,
    identity: {
      subject,
      email,
      emailVerified: email !== null,
      displayName: name,
      groups: groupsFrom(entry[groupsAttribute]),
      idpSessionId: null,
      hostedDomain: null,
      notes: [],
    },
  };
}
