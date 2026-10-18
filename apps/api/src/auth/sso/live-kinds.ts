import type { IdpKind } from '@knowledge/contracts';

/**
 * Provider kinds that can sign anyone in on this instance (#75). One answer
 * for creation, the login page, discovery and enforced SSO, so a provider
 * cannot be offered as a sign-in it cannot complete — and an LDAP provider
 * stops counting the moment AUTH_LDAP_ENABLED is switched off.
 */
export function liveIdpKinds(config: { get(key: 'AUTH_LDAP_ENABLED'): unknown }): IdpKind[] {
  return config.get('AUTH_LDAP_ENABLED') === true ? ['oidc', 'saml', 'ldap'] : ['oidc', 'saml'];
}
