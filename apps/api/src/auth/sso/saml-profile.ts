import type { IdentityProvider } from '@prisma/client';
import type { SamlProviderConfig } from '@knowledge/contracts';
import { groupsFrom, str, type ClaimsResult } from './oidc-claims.js';

/** What `identity_providers.config` holds for a SAML provider: the admin's settings plus our SP certificate. */
export interface StoredSamlConfig extends SamlProviderConfig {
  spCert: string;
}

export function samlConfigOf(provider: Pick<IdentityProvider, 'config'>): StoredSamlConfig {
  const raw = (provider.config ?? {}) as Record<string, unknown>;
  return {
    idpEntityId: str(raw.idpEntityId) ?? '',
    ssoUrl: str(raw.ssoUrl) ?? '',
    idpCert: str(raw.idpCert) ?? '',
    allowIdpInitiated: raw.allowIdpInitiated === true,
    emailAttribute: str(raw.emailAttribute),
    nameAttribute: str(raw.nameAttribute),
    spCert: str(raw.spCert) ?? '',
  };
}

/** The names IdPs ship by default: Keycloak and Okta, Entra and ADFS, then the X.500 OIDs. */
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'cn',
];
const GIVEN_ATTRIBUTES = ['firstName', 'givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname', 'urn:oid:2.5.4.42'];
const SURNAME_ATTRIBUTES = ['lastName', 'sn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname', 'urn:oid:2.5.4.4'];
/** Entra sends this link instead of the groups once a person is in more than 150. */
const ENTRA_GROUPS_LINK = 'http://schemas.microsoft.com/claims/groups.link';

const NAMEID_TRANSIENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient';
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

type Attributes = Record<string, unknown>;

const first = (v: unknown): string | null => str(Array.isArray(v) ? v.find((x) => typeof x === 'string') : v);
const pick = (attrs: Attributes, names: (string | null)[]): string | null => {
  for (const n of names) if (n && first(attrs[n])) return first(attrs[n]);
  return null;
};

/**
 * Map a validated assertion — node-saml has already checked the signature,
 * audience, timestamps and `InResponseTo` — to the one identity shape every
 * SSO kind feeds `SsoLoginService`.
 *
 * SAML has no `email_verified`. The address counts as vouched for because it
 * arrives in an assertion signed by the certificate the admin pinned. What
 * stops that IdP from speaking for someone else's mailbox is the same rule as
 * for OIDC: the domain must be one of the provider's `allowedDomains`.
 */
export function identityFromSamlProfile(
  profile: { nameID?: string; nameIDFormat?: string; attributes?: Attributes },
  opts: { emailAttribute: string | null; nameAttribute: string | null; groupsAttribute: string | null },
): ClaimsResult {
  const subject = str(profile.nameID);
  if (!subject) return { ok: false, error: 'id-token-invalid', reason: 'no NameID' };
  // A transient NameID is new at every sign-in: it would link a fresh identity each time.
  if (profile.nameIDFormat === NAMEID_TRANSIENT) return { ok: false, error: 'id-token-invalid', reason: 'transient NameID' };

  const attrs = profile.attributes ?? {};
  const email =
    (opts.emailAttribute ? first(attrs[opts.emailAttribute]) : pick(attrs, EMAIL_ATTRIBUTES)) ??
    (profile.nameIDFormat === NAMEID_EMAIL ? subject : null);
  const joined = [pick(attrs, GIVEN_ATTRIBUTES), pick(attrs, SURNAME_ATTRIBUTES)].filter(Boolean).join(' ');
  const notes: string[] = [];
  const groups = opts.groupsAttribute ? groupsFrom(attrs[opts.groupsAttribute]) : [];
  if (opts.groupsAttribute && !groups.length && attrs[ENTRA_GROUPS_LINK] !== undefined) notes.push('groups-overage');

  return {
    ok: true,
    identity: {
      subject,
      email: email?.toLowerCase() ?? null,
      emailVerified: email !== null,
      displayName: (opts.nameAttribute ? first(attrs[opts.nameAttribute]) : pick(attrs, NAME_ATTRIBUTES)) ?? (joined || null),
      groups,
      idpSessionId: null,
      hostedDomain: null,
      notes,
    },
  };
}
