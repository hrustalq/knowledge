import type { IdpKind } from '@knowledge/contracts';

/**
 * Provider kinds that can sign anyone in today (#75). One list for creation,
 * the login page, the callback and enforced SSO, so a provider cannot be
 * offered as a sign-in it cannot complete. LDAP joins with its phase.
 */
export const LIVE_IDP_KINDS: IdpKind[] = ['oidc', 'saml'];
