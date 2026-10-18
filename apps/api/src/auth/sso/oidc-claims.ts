import type { IdpPreset, SsoLoginError } from '@knowledge/contracts';

/**
 * Who an identity provider says signed in, in one shape whatever the protocol
 * (#75). OIDC fills it from the id_token and userinfo; SAML and LDAP will fill
 * the same shape, so `SsoLoginService` is the only place that decides what a
 * sign-in may do.
 */
export interface ExternalIdentity {
  /** OIDC `sub`, SAML NameID, LDAP entryUUID — stable for the person at that IdP. */
  subject: string;
  email: string | null;
  /** The IdP vouches for the address. Linking to an existing account needs it. */
  emailVerified: boolean;
  displayName: string | null;
  groups: string[];
  /** OIDC `sid`, for back-channel logout. */
  idpSessionId: string | null;
  /**
   * The org domain the IdP asserts the account belongs to (Google's `hd`), as
   * opposed to the address's domain, which anyone can put in a profile.
   */
  hostedDomain: string | null;
  /** Worth an audit note but not a refusal — an Entra groups overage. */
  notes: string[];
}

export type ClaimsResult = { ok: true; identity: ExternalIdentity } | { ok: false; error: SsoLoginError; reason: string };

/** A token's group list is IdP-controlled input: bounded before anything compares against it. */
const MAX_GROUPS = 500;
const MAX_GROUP_LENGTH = 256;

type Claims = Record<string, unknown>;

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Some IdPs send `"true"`: a string is believed only when it says exactly that. */
const truthy = (v: unknown): boolean => v === true || v === 'true';

export function groupsFrom(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(list.filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= MAX_GROUP_LENGTH))].slice(
    0,
    MAX_GROUPS,
  );
}

function displayNameFrom(c: Claims): string | null {
  const joined = [str(c.given_name), str(c.family_name)].filter(Boolean).join(' ');
  return str(c.name) ?? (joined || null) ?? str(c.preferred_username);
}

/** The tenant an Entra issuer pins: `https://login.microsoftonline.com/<tenant>/v2.0`. */
export function entraTenantOf(issuer: string): string | null {
  const m = issuer.match(/login\.microsoftonline\.com\/([^/]+)\/v2\.0\/?$/i);
  if (!m) return null;
  const tenant = m[1].toLowerCase();
  // A multi-tenant authority pins nothing; the id_token's `iss` names the real one.
  return ['common', 'organizations', 'consumers'].includes(tenant) ? null : tenant;
}

/**
 * Map OIDC claims (the validated id_token, merged with userinfo) to an
 * identity. The library has already checked the signature, issuer, audience,
 * expiry and nonce; what is left is what each IdP means by its claims.
 */
export function identityFromClaims(
  preset: IdpPreset,
  claims: Claims,
  opts: { issuer: string; groupsClaim: string | null },
): ClaimsResult {
  const subject = str(claims.sub);
  if (!subject) return { ok: false, error: 'id-token-invalid', reason: 'no sub claim' };

  let emailVerified = truthy(claims.email_verified);
  let groups = opts.groupsClaim ? groupsFrom(claims[opts.groupsClaim]) : [];
  const notes: string[] = [];

  if (preset === 'entra') {
    const pinned = entraTenantOf(opts.issuer);
    const tid = str(claims.tid)?.toLowerCase() ?? null;
    if (pinned && tid !== pinned) return { ok: false, error: 'id-token-invalid', reason: `tid ${tid ?? 'missing'} is not ${pinned}` };
    // Entra sends no email_verified. `xms_edov` (an optional claim) says the
    // address's domain is verified by the tenant — the only claim that does.
    emailVerified = emailVerified || truthy(claims.xms_edov);
    const names = claims._claim_names as Record<string, unknown> | undefined;
    if (opts.groupsClaim && names && typeof names === 'object' && opts.groupsClaim in names) {
      groups = [];
      notes.push('groups-overage');
    }
  }

  return {
    ok: true,
    identity: {
      subject,
      email: str(claims.email)?.toLowerCase() ?? null,
      emailVerified,
      displayName: displayNameFrom(claims),
      groups,
      idpSessionId: str(claims.sid),
      hostedDomain: str(claims.hd)?.toLowerCase() ?? null,
      notes,
    },
  };
}

/**
 * Yandex ID's userinfo (`login.yandex.ru/info`): `id` is the stable subject and
 * `default_email` the account's address, which Yandex has confirmed — an
 * address it cannot deliver to does not become the default.
 */
export function identityFromYandex(info: Claims): ClaimsResult {
  const id = info.id;
  const subject = typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  if (!subject) return { ok: false, error: 'id-token-invalid', reason: 'no id in userinfo' };
  const email = str(info.default_email)?.toLowerCase() ?? null;
  return {
    ok: true,
    identity: {
      subject,
      email,
      emailVerified: email !== null,
      displayName: str(info.real_name) ?? str(info.display_name) ?? str(info.login),
      groups: [],
      idpSessionId: null,
      hostedDomain: null,
      notes: [],
    },
  };
}
