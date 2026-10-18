import type { IdpKind } from '@knowledge/contracts';

/**
 * Provider kinds that can sign anyone in today (#75). One list for creation,
 * the login page, the callback and enforced SSO, so a provider cannot be
 * offered as a sign-in it cannot complete. SAML and LDAP join with their phases.
 */
export const LIVE_IDP_KINDS: IdpKind[] = ['oidc'];
