import type { IdpPreset } from '@knowledge/contracts';

/**
 * What each preset changes about an OIDC sign-in (#75). Everything not here
 * is plain OpenID Connect: discovery from the issuer, code + PKCE, a nonce,
 * an id_token the library validates (iss, aud, exp, nonce, azp).
 */
export interface OidcPreset {
  /** Scopes requested beyond `openid` when the provider names none. */
  scopes: readonly string[];
  /** The claim group names arrive in; null when the IdP puts none in a token. */
  groupsClaim: string | null;
  /** A fixed issuer: the preset is one IdP, so there is nothing for an admin to type. */
  issuer?: string;
  /**
   * OAuth 2 + userinfo instead of OIDC: fixed endpoints, no discovery, no
   * id_token, so no nonce either — the code grant is protected by state and
   * PKCE, and the subject comes from the userinfo answer.
   */
  oauth2?: { authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string };
}

export const OIDC_PRESETS: Record<IdpPreset, OidcPreset> = {
  // Realm issuer `https://<host>/realms/<realm>`; groups need a "Group Membership" mapper.
  keycloak: { scopes: ['email', 'profile'], groupsClaim: 'groups' },
  // `https://login.microsoftonline.com/<tenant-id>/v2.0`. More than 200 groups
  // arrive as an overage reference instead of a list — read as no groups.
  entra: { scopes: ['email', 'profile'], groupsClaim: 'groups' },
  // No groups in a Google id_token: Google relies on SCIM or manual mapping.
  google: { scopes: ['email', 'profile'], groupsClaim: null, issuer: 'https://accounts.google.com' },
  // Yandex ID publishes no discovery document and issues no id_token.
  yandex: {
    scopes: ['login:email', 'login:info'],
    groupsClaim: null,
    issuer: 'https://oauth.yandex.ru',
    oauth2: {
      authorizationEndpoint: 'https://oauth.yandex.ru/authorize',
      tokenEndpoint: 'https://oauth.yandex.ru/token',
      userinfoEndpoint: 'https://login.yandex.ru/info?format=json',
    },
  },
  generic: { scopes: ['email', 'profile'], groupsClaim: 'groups' },
};

export function presetOf(stored: string): IdpPreset {
  return stored in OIDC_PRESETS ? (stored as IdpPreset) : 'generic';
}
