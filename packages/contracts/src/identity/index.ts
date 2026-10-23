import type { IngestionJobStatus, Locale, RevisionStatus } from '@knowledge/contracts/core';
import type { FactExtractor } from '@knowledge/contracts/graph';

// stale detection / reindex scheduling, historical fact queries
// ---------------------------------------------------------------------------

/**
 * Workspace role hierarchy: guest < viewer < editor < admin.
 *
 * `guest` sits below the ladder rather than on it: a guest reads nothing in the
 * workspace except what is granted to them or their groups (#76), so every
 * workspace-level `@Access('viewer', …)` route refuses one without knowing
 * guests exist.
 */
export const WORKSPACE_ROLES = ['guest', 'viewer', 'editor', 'admin'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Grained permissions a member holds beside their role (#468), stored in
 * `workspace_members.capabilities`. Closed: the API guard, the agent run and
 * the web all read {@link hasCapability}, and a value outside this list is
 * dropped on read. Like `trustedOperator`, independent of role — a viewer may
 * hold one and an editor may not — and set by hand only: SSO role sync and
 * SCIM never write it.
 */
export const MEMBER_CAPABILITIES = [
  /** Generate and regenerate an operation's QA test suite (spends the AI budget). */
  'api-test-suites.generate',
  /** Run a suite against a real server: the browser runner, its proxied steps and the run plan (#483). */
  'api-test-suites.run',
] as const;
export type MemberCapability = (typeof MEMBER_CAPABILITIES)[number];

/** The catalogue's values in a stored column, deduplicated; anything else is dropped. */
export function memberCapabilitiesOf(stored: unknown): MemberCapability[] {
  return Array.isArray(stored)
    ? MEMBER_CAPABILITIES.filter((c) => stored.includes(c))
    : [];
}

/**
 * The one predicate (#468). Workspace admins and platform admins hold every
 * capability implicitly; everyone else holds what their row lists.
 */
export function hasCapability(
  member: { role: string; capabilities: unknown } | null | undefined,
  capability: MemberCapability,
  platformAdmin = false,
): boolean {
  if (platformAdmin) return true;
  if (!member) return false;
  return member.role === 'admin' || memberCapabilitiesOf(member.capabilities).includes(capability);
}

export interface WorkspaceMembership {
  workspaceId: string;
  role: WorkspaceRole;
  /** Gate for POST /v1/graph/query / knowledge.query_graph (plan.md section 9). */
  trustedOperator: boolean;
  /** Granted by hand, beside the role (#468). Admins hold every one without it being listed. */
  capabilities: MemberCapability[];
  /** Who manages the row (#75): a person by hand, or an identity provider. */
  source: MembershipSource;
}

// ---------------------------------------------------------------------------
// Enterprise auth (#75): how a session was opened and who manages a membership.
// ---------------------------------------------------------------------------

/** `sessions.auth_method`. Every session that predates SSO is `password`. */
export const AUTH_METHODS = ['password', 'oidc', 'saml', 'ldap'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/**
 * `workspace_members.source`. Only `manual` rows are edited by people; the
 * others belong to JIT, group sync or SCIM, which never touch a `manual` one.
 */
export const MEMBERSHIP_SOURCES = ['manual', 'jit', 'group', 'scim'] as const;
export type MembershipSource = (typeof MEMBERSHIP_SOURCES)[number];

/** A stored value outside the vocabulary reads as its default, never as a new kind. */
export function authMethodOf(stored: string): AuthMethod {
  return (AUTH_METHODS as readonly string[]).includes(stored) ? (stored as AuthMethod) : 'password';
}
export function membershipSourceOf(stored: string): MembershipSource {
  return (MEMBERSHIP_SOURCES as readonly string[]).includes(stored) ? (stored as MembershipSource) : 'manual';
}

/**
 * `audit_logs.action`. Every value here is written by at least one code path,
 * and `audit.service.spec.ts` fails if one stops being: a filter must not offer
 * an action nothing records. Later phases of #75 add their actions with the
 * code that emits them.
 */
export const AUDIT_ACTIONS = [
  'graph.query',
  'acl.bypass',
  'acl.update',
  'acl.request',
  'acl.request.approve',
  'acl.request.deny',
  'ai-readable.llms-full',
  'api.try',
  'feedback.export',
  'analytics.export',
  'merge-request.lint-override',
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.session_revoked',
  'sso.provider_created',
  'sso.provider_updated',
  'sso.provider_deleted',
  'sso.jit_user_created',
  'sso.identity_linked',
  'sso.group_mapping_created',
  'sso.group_mapping_deleted',
  'role_sync.applied',
  'role_sync.blocked_last_admin',
  'sso.domain_claimed',
  'sso.domain_verified',
  'sso.domain_enforced',
  'sso.domain_updated',
  'sso.domain_removed',
  'sso.policy_updated',
  'auth.sso_bypassed',
  'scim.user_created',
  'scim.user_updated',
  'scim.user_deactivated',
  'scim.user_deleted',
  'scim.group_created',
  'scim.group_updated',
  'scim.group_deleted',
  'scim.token_created',
  'scim.token_revoked',
  'scim.settings_updated',
  'chat.search_enabled',
  'chat.search_disabled',
  'chat.listen_enabled',
  'chat.listen_disabled',
  'chat.auto_harvest_enabled',
  'chat.auto_harvest_disabled',
  /** A member's capabilities changed (#468): `params` lists what was granted and revoked. */
  'member.capabilities_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Identity providers (#75 phase 2). Owned by a workspace; a platform admin may
// mark one `platformWide` so a single-tenant install offers it on every login.
// ---------------------------------------------------------------------------

/** `identity_providers.kind`. LDAP is offered only under AUTH_LDAP_ENABLED. */
export const IDP_KINDS = ['oidc', 'saml', 'ldap'] as const;
export type IdpKind = (typeof IDP_KINDS)[number];

/**
 * `identity_providers.preset`: which IdP's quirks apply. `yandex` is OAuth 2 +
 * userinfo rather than OIDC (no discovery document, no id_token), so its
 * endpoints are fixed and `issuer` is ignored.
 */
export const IDP_PRESETS = ['keycloak', 'entra', 'google', 'yandex', 'generic'] as const;
export type IdpPreset = (typeof IDP_PRESETS)[number];

/** Additive grants what the IdP's groups map to; authoritative also takes away what they no longer do. */
export const GROUP_SYNC_MODES = ['additive', 'authoritative'] as const;
export type GroupSyncMode = (typeof GROUP_SYNC_MODES)[number];

/**
 * One IdP group → one workspace role (#75 phases 3 and 5). On every SSO
 * sign-in the person's groups are matched against the mappings of the
 * provider they used; a SCIM group's mapping (no provider) applies as soon as
 * provisioning changes the group. The highest mapped role wins, and any
 * matching mapping with `trustedOperator` grants it. Rows a person set by hand
 * are never touched.
 */
export interface GroupMappingView {
  id: string;
  workspaceId: string;
  /** Null for a SCIM group's mapping. */
  providerId: string | null;
  /** The provider's name, for the table; null if it has since been removed, or for a SCIM mapping. */
  providerName: string | null;
  /** The value as it arrives in the provider's groups claim, or the SCIM group's id. */
  externalGroup: string;
  /** A SCIM mapping's group name; null if the client has since deleted the group, or for a provider mapping. */
  scimGroupName: string | null;
  role: WorkspaceRole;
  trustedOperator: boolean;
  createdAt: string;
}

// GET /v1/workspaces/:id/group-mappings
export interface ListGroupMappingsResponse {
  mappings: GroupMappingView[];
  /** Providers a mapping may name: the workspace's own and every platform-wide one. Empty while SSO is off. */
  providers: { id: string; name: string; groupSyncMode: GroupSyncMode; groupsClaim: string | null }[];
  /** Groups the workspace's SCIM client has pushed. Empty while SCIM is off. */
  scimGroups: { id: string; displayName: string; memberCount: number }[];
  /** Which kinds of mapping the instance offers: AUTH_SSO_ENABLED and AUTH_SCIM_ENABLED (both under AUTH_MODE=api-key). */
  enabled: { sso: boolean; scim: boolean };
}

// ---------------------------------------------------------------------------
// SCIM 2.0 provisioning (#75 phase 5). A workspace's IdP creates, updates and
// deactivates its people over /v1/scim/v2 with a `kscim_` bearer token. The
// token is a credential for that workspace's provisioning only — never a
// principal, so it opens no other route.
// ---------------------------------------------------------------------------

/**
 * `workspace_settings.scim_default_role`: what a provisioned user is given
 * when no mapped SCIM group says more. `none` grants nothing without a group.
 */
export const SCIM_DEFAULT_ROLES = ['none', ...WORKSPACE_ROLES] as const;
export type ScimDefaultRole = (typeof SCIM_DEFAULT_ROLES)[number];

/** A SCIM token as its workspace's admins see it. Never the secret. */
export interface ScimTokenView {
  id: string;
  name: string;
  /** `kscim_` and the next 8 characters: enough to recognise it in the IdP's settings. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// GET/PUT /v1/workspaces/:id/scim
export interface ScimSettingsView {
  workspaceId: string;
  /** The SCIM base URL to paste into the IdP: `${API_PUBLIC_URL}/v1/scim/v2`. */
  baseUrl: string;
  /** Stored null reads as `viewer`. */
  defaultRole: ScimDefaultRole;
  tokens: ScimTokenView[];
  /** Users and groups the client has provisioned into this workspace. */
  users: number;
  activeUsers: number;
  groups: number;
}

// POST /v1/workspaces/:id/scim-tokens
export interface ScimTokenCreated {
  token: ScimTokenView;
  /** The bearer token itself, shown once. Only its SHA-256 is stored. */
  secret: string;
}

// ---------------------------------------------------------------------------
// Enforced SSO (#75 phase 4): a workspace policy, and email domains a
// workspace has proven it owns.
// ---------------------------------------------------------------------------

/**
 * The `workspace_settings` auth columns as an admin set them. `null` inherits:
 * an empty row is no enforcement, keys allowed, no admin password exception,
 * and the instance session lifetime.
 */
export interface WorkspaceAuthPolicySettings {
  /** Sessions must come from one of this workspace's (or a platform-wide) providers. */
  ssoEnforced: boolean | null;
  /** Under enforced SSO, `kn_` keys still open the workspace. Null is yes. */
  allowApiKeys: boolean | null;
  /** Platform admins may still use a password on this workspace's enforced domains. Null is no. */
  allowPasswordForAdmins: boolean | null;
  /** A session older than this must sign in again to reach the workspace. Null is no cap. */
  sessionMaxAgeHours: number | null;
}

/** What the API enforces after the instance ceilings. */
export interface WorkspaceAuthPolicyApplied {
  ssoEnforced: boolean;
  allowApiKeys: boolean;
  allowPasswordForAdmins: boolean;
  /** Null when no cap applies — none asked, or one no shorter than AUTH_SESSION_TTL_HOURS. */
  sessionMaxAgeHours: number | null;
}

// GET/PUT /v1/workspaces/:id/auth-policy
export interface WorkspaceAuthPolicyView {
  workspaceId: string;
  asked: WorkspaceAuthPolicySettings;
  applied: WorkspaceAuthPolicyApplied;
  /** The instance values that clamp `asked`: AUTH_SSO_ENABLED (with AUTH_MODE=api-key) and AUTH_SESSION_TTL_HOURS. */
  ceilings: { ssoEnabled: boolean; sessionTtlHours: number };
  /** Enabled providers whose sessions satisfy enforcement. */
  providers: { id: string; name: string }[];
  updatedAt: string | null;
}

/** `PUT /v1/workspaces/:id/auth-policy` refuses to save a policy its own caller would fail. */
export type AuthPolicyFailure = 'password-session' | 'foreign-provider' | 'api-key' | 'session-too-old';

/** An email domain a workspace claims. Only a verified one may be enforced. */
export interface SsoDomainView {
  /** Lower-case punycode. */
  domain: string;
  workspaceId: string;
  /** The provider people on this domain are sent to; null = any of the workspace's. */
  providerId: string | null;
  providerName: string | null;
  /** The DNS name to publish the TXT record at: `_knowledge-challenge.<domain>`. */
  recordName: string;
  /** The TXT record's value. */
  verificationToken: string;
  verifiedAt: string | null;
  /** Password sign-in, signup and reset are refused for addresses on this domain. */
  enforced: boolean;
  createdAt: string;
  /** Until when the API keeps rechecking DNS by itself; null once verified. */
  recheckUntil: string | null;
}

// GET /v1/workspaces/:id/sso-domains
export interface ListSsoDomainsResponse {
  domains: SsoDomainView[];
  /** Providers a domain may send people to: the workspace's own and every platform-wide one. */
  providers: { id: string; name: string }[];
  /** The caller is a platform admin and may mark a domain verified without DNS. */
  canVerifyManually: boolean;
}

// POST /v1/workspaces/:id/sso-domains/:domain/verify
export interface VerifySsoDomainResponse {
  domain: SsoDomainView;
  /** Why DNS did not prove it, when it did not: `no-record`, `mismatch`, `lookup-failed`. */
  error: 'no-record' | 'mismatch' | 'lookup-failed' | null;
}

/** The non-secret half of an OIDC provider (`identity_providers.config`). */
export interface OidcProviderConfig {
  /** The issuer identifier; discovery is `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  /** `openid` is always requested; these are added to it. */
  scopes: string[];
}

/**
 * The non-secret half of a SAML provider (#75 phase 6). The groups attribute
 * is the provider's `groupsClaim`, shared with OIDC; the SP key pair is made
 * on create and only its certificate leaves the API, inside the metadata.
 */
export interface SamlProviderConfig {
  /** The IdP's entity ID: the assertion's `Issuer` must equal it. */
  idpEntityId: string;
  /** Where the browser is sent with the AuthnRequest (HTTP-Redirect binding). */
  ssoUrl: string;
  /** PEM certificate(s) the IdP signs with; two during a rollover. */
  idpCert: string;
  /** Accept a response no AuthnRequest of ours asked for (a tile in the IdP's app portal). */
  allowIdpInitiated: boolean;
  /** Attribute holding the address; null tries the usual names, then an email-format NameID. */
  emailAttribute: string | null;
  /** Attribute holding the display name; null tries the usual names. */
  nameAttribute: string | null;
}

/**
 * The search an LDAP sign-in runs when the provider names none: a person
 * whose uid, mail, sAMAccountName or userPrincipalName is what they typed.
 * `{username}` is replaced by the typed value, escaped per RFC 4515.
 */
export const LDAP_DEFAULT_USER_FILTER =
  '(&(objectClass=person)(|(uid={username})(mail={username})(sAMAccountName={username})(userPrincipalName={username})))';

/**
 * The non-secret half of an LDAP / Active Directory provider (#75 phase 7).
 * The service account's password is the provider's secret (write-only, like
 * an OIDC client secret); the groups attribute is its `groupsClaim`, which
 * defaults to `memberOf`.
 */
export interface LdapProviderConfig {
  /** `ldaps://host[:port]`, or `ldap://` with `startTls`. */
  url: string;
  /** Upgrade an `ldap://` connection with StartTLS before anything is sent. */
  startTls: boolean;
  /** The service account that searches for the person; null searches anonymously. */
  bindDn: string | null;
  /** Where the search starts, e.g. `ou=people,dc=corp,dc=example`. */
  baseDn: string;
  /** Null uses LDAP_DEFAULT_USER_FILTER. Must contain `{username}`. */
  userFilter: string | null;
  /** Attribute holding the address; null is `mail`. */
  emailAttribute: string | null;
  /** Attribute holding the display name; null tries displayName, then cn. */
  nameAttribute: string | null;
}

export interface SamlProviderView extends SamlProviderConfig {
  /** Our entity ID, which is also the URL the SP metadata is served at. */
  entityId: string;
}

export interface IdentityProviderView {
  id: string;
  workspaceId: string;
  kind: IdpKind;
  preset: IdpPreset;
  name: string;
  enabled: boolean;
  showOnLogin: boolean;
  platformWide: boolean;
  /** OIDC settings; empty strings for a SAML provider. */
  config: OidcProviderConfig;
  /** SAML settings and our SP endpoints; null for OIDC. */
  saml: SamlProviderView | null;
  /** LDAP settings; null for the other kinds. */
  ldap: LdapProviderConfig | null;
  /** A client secret is stored. The secret itself never leaves the API. */
  hasSecret: boolean;
  jitEnabled: boolean;
  defaultRole: WorkspaceRole | null;
  /** Email domains this provider may assert. Linking and JIT both need the address to be in one. */
  allowedDomains: string[];
  groupsClaim: string | null;
  groupSyncMode: GroupSyncMode;
  sessionTtlHours: number | null;
  /** What to register at the IdP: the OIDC redirect URI, or the SAML ACS URL. Empty for LDAP. */
  redirectUri: string;
  /** OIDC back-channel logout URI to register at the IdP; null for kinds and presets without one. */
  backchannelLogoutUri: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /v1/workspaces/:id/identity-providers
export interface ListIdentityProvidersResponse {
  providers: IdentityProviderView[];
  /** SETTINGS_ENCRYPTION_KEY is set: a client secret can be saved. */
  secretsWritable: boolean;
  /** The kinds a new provider may have on this instance (LDAP only under AUTH_LDAP_ENABLED). */
  kinds: IdpKind[];
}

// POST /v1/workspaces/:id/identity-providers/:providerId/test
export interface TestIdentityProviderResponse {
  ok: boolean;
  /** The issuer the discovery document names, when it was reached. */
  issuer: string | null;
  authorizationEndpoint: string | null;
  error: string | null;
}

/** A provider as the login page shows it: enough for a button, nothing more. */
export interface SsoLoginProvider {
  id: string;
  name: string;
  kind: IdpKind;
  preset: IdpPreset;
}

// GET /v1/auth/sso/providers?workspaceId=
export interface SsoProvidersResponse {
  providers: SsoLoginProvider[];
  /** AUTH_PASSWORD_LOGIN_ENABLED: the password form is offered at all. */
  passwordLogin: boolean;
}

// POST /v1/auth/sso/discover
export interface SsoDiscoverResponse {
  /** `sso` when a provider asserts this address's domain. Never says whether an account exists. */
  method: 'password' | 'sso';
  /**
   * The domain is verified and enforced (#75 phase 4): a password is refused
   * for it, break-glass aside. Says nothing about whether an account exists.
   */
  enforced: boolean;
  providers: SsoLoginProvider[];
  /** A password may still be used for this address (the ceiling, or a break-glass entry). */
  passwordAllowed: boolean;
}

// POST /v1/auth/sso/exchange
export interface SsoExchangeResponse extends AuthSessionResponse {
  /** The web path the sign-in started from. */
  returnTo: string;
}

/**
 * Why an SSO callback sent the browser back to `/login?error=`. The reason in
 * detail goes to the audit trail; the browser gets one of these.
 */
export const SSO_LOGIN_ERRORS = [
  'invalid-state',
  'provider-error',
  'id-token-invalid',
  'email-missing',
  'email-not-verified',
  'domain-not-allowed',
  'jit-disabled',
  'account-disabled',
  /** The fragment code was unknown, expired or already spent (POST /v1/auth/sso/exchange). */
  'exchange-invalid',
  'failed',
] as const;
export type SsoLoginError = (typeof SSO_LOGIN_ERRORS)[number];

/** One login session, as its owner (or a platform admin) sees it. Never the token. */
export interface SessionView {
  id: string;
  authMethod: AuthMethod;
  /** identity_providers.id for an SSO login. */
  providerId: string | null;
  /** That provider's login-button name, while the provider still exists (#292). */
  providerName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  /** Null until the session is first used after sign-in. */
  lastSeenAt: string | null;
  expiresAt: string;
  /** The session this request came in on. */
  current: boolean;
}

// GET /v1/me/sessions, GET /v1/users/:id/sessions
export interface ListSessionsResponse {
  sessions: SessionView[];
}

// POST /v1/users/:id/revoke-sessions
export interface RevokeSessionsResponse {
  revoked: number;
}

// GET /v1/me
/**
 * Where to fetch a picture, or null when there is none and the face is drawn
 * from initials (people) or a monogram (projects) instead.
 *
 * Always a bare `/v1/...` path, never an absolute URL: one value has to work
 * through the dev proxy, in production, and during SSR. The browser turns it
 * into something an `<img>` can load with `resolveAssetUrl()`, which adds the
 * host and the `?token=` — an `<img>` cannot send an Authorization header. A
 * `?v=` stamp rides along, because replacing a picture reuses its key and would
 * otherwise be invisible to everyone who had already loaded the old one.
 */
export type AvatarUrl = string | null;

export interface MeResponse {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  /** 'dev' = AUTH_MODE=none (full access); 'api-key' = Bearer API key; 'session' = login session token. */
  mode: 'dev' | 'api-key' | 'session';
  /** Platform admin (users.is_admin): full access to every workspace + user management. */
  isAdmin: boolean;
  /** UI + API language (docs/features/18). 'en' for the dev principal, which has no users row. */
  locale: Locale;
  /** How the current session was opened (#75); null for an API key or the dev principal. */
  authMethod: AuthMethod | null;
  /** The address is proven (docs/features/41). Always true for the dev principal. */
  emailVerified: boolean;
  /**
   * AUTH_REQUIRE_VERIFIED_EMAIL: while `emailVerified` is false, every route but
   * /me, logout and resend-verification answers 403 `emailUnverified`.
   */
  emailVerificationRequired: boolean;
  /** Empty in dev mode (the dev principal is admin+operator everywhere). */
  memberships: WorkspaceMembership[];
}


export interface GraphQueryResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the row cap cut the result off. */
  truncated: boolean;
  durationMs: number;
}

export interface AuditLogEntry {
  id: string;
  /** Null for a platform event — a sign-in belongs to no workspace (#75). */
  workspaceId: string | null;
  /** users.id, or a synthetic actor ("dev", "mcp-operator", "anonymous"). */
  actor: string;
  /** An {@link AuditAction}; typed as string because old rows may hold a retired one. */
  action: string;
  /** Client address of the request behind it, when there was one. */
  ip: string | null;
  /** Who or what it was done to — a user id, a provider id. */
  target: string | null;
  params: Record<string, unknown>;
  rowCount: number | null;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

// GET /v1/audit-logs?workspaceId=&action=&cursor=
export interface ListAuditLogsResponse {
  workspaceId: string;
  entries: AuditLogEntry[];
  /** Pass as `cursor` for the next (older) page; null on the last one. */
  nextCursor: string | null;
}

// GET /v1/admin/audit-logs?action=&cursor= (platform admin; includes platform events)
export interface ListPlatformAuditLogsResponse {
  entries: AuditLogEntry[];
  nextCursor: string | null;
}

/** A fact as asserted at a point in the revision DAG (Phase 5 historical queries). */
export interface HistoricalFact {
  type: string;
  targetKey: string;
  entityType: string;
  name: string;
  extractor: FactExtractor | string;
  confidence: number;
  /** Revision that asserted the fact; null for un-anchored document-level facts. */
  assertedByRevisionId: string | null;
}

// GET /v1/documents/:id/facts?at=<revisionId>
export interface FactsAtResponse {
  documentId: string;
  atRevisionId: string;
  /**
   * The ancestor revision whose revision-scoped fact set is the effective
   * snapshot at `at` (null when no ancestor asserted revision-scoped facts).
   */
  effectiveRevisionId: string | null;
  facts: HistoricalFact[];
}

export interface FactTimelineEntry {
  type: string;
  targetKey: string;
  extractor: FactExtractor | string;
  /**
   * `removed`: a later revision stopped asserting it. `retracted` (#81): a
   * person withdrew it, or a re-extraction of the same revision dropped it —
   * the page did not change, the belief did.
   */
  status: 'active' | 'removed' | 'retracted';
  introducedInRevisionId: string | null;
  introducedAt: string | null;
  /** First later revision that asserted facts without this one (removed-facts audit). */
  removedInRevisionId: string | null;
  removedAt: string | null;
  /** When the fact was retracted (#81); null unless `status` is `retracted`. */
  retractedAt: string | null;
  /** `user:<id>` or `extractor`; null unless `status` is `retracted`. */
  retractedBy: string | null;
}

// GET /v1/documents/:id/facts/timeline?branch=
export interface FactTimelineResponse {
  documentId: string;
  branch: string;
  entries: FactTimelineEntry[];
}

// GET /v1/ingestion/jobs/:id
export interface IngestionJobInfo {
  jobId: string;
  workspaceId: string;
  revisionId: string;
  type: string;
  status: IngestionJobStatus | string;
  attempts: number;
  error: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// GET /v1/ingestion/stale?workspaceId=
export interface StaleReportResponse {
  workspaceId: string;
  /** Current embedding signature (provider:model:dim); heads indexed under a different one are drifted. */
  embeddingSignature: string;
  driftedHeads: Array<{
    documentId: string;
    revisionId: string;
    title: string;
    embeddingModel: string | null;
    indexedAt: string | null;
  }>;
  stuckIndexing: Array<{ jobId: string; revisionId: string; startedAt: string | null }>;
  failedJobs: Array<{ jobId: string; revisionId: string; attempts: number; error: unknown }>;
}

export interface ReindexResponse {
  workspaceId: string;
  enqueued: number;
  jobIds: string[];
}

// ---------------------------------------------------------------------------
// Product features (docs/features): categorization, nesting, full content,
// Phase 5 api-key auth) + users & access-control management.
// ---------------------------------------------------------------------------



/** Returned by signup and login: a `ks_` session token (send as Bearer). */
export interface AuthSessionResponse {
  token: string;
  expiresAt: string;
  me: MeResponse;
}

// POST /v1/auth/logout
export interface LogoutResponse {
  ok: boolean;
}

/**
 * POST /v1/auth/url-ticket (#102): a single-use `kt_` credential for a URL
 * that cannot carry a header (EventSource). Put it in `?token=`; it is
 * redeemed on first use and expires at `expiresAt` either way.
 */
export interface UrlTicketResponse {
  ticket: string;
  expiresAt: string;
}

export interface ForgotPasswordResponse {
  /** Always true — the endpoint never reveals whether the email exists. */
  ok: boolean;
  /** Reset token echoed back outside production only, so a dev flow needs no inbox. */
  debugToken?: string;
}

/** POST /v1/auth/verify-email (docs/features/41). */
export interface VerifyEmailResponse {
  ok: boolean;
}

/** POST /v1/auth/resend-verification. `alreadyVerified` = nothing was sent. */
export interface ResendVerificationResponse {
  ok: boolean;
  alreadyVerified: boolean;
  /** Verification token echoed back outside production only. */
  debugToken?: string;
}

export interface ResetPasswordResponse {
  ok: boolean;
}


// ---------------------------------------------------------------------------
// Users management (platform admin)
// ---------------------------------------------------------------------------

export interface UserSummary {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  isAdmin: boolean;
  /** Disabled users cannot authenticate (sessions and API keys stop working). */
  disabled: boolean;
  hasPassword: boolean;
  /** users.email_verified_at is set (docs/features/41). */
  emailVerified: boolean;
  hasApiKey: boolean;
  createdAt: string;
  memberships: WorkspaceMembership[];
}

// GET /v1/users
export interface ListUsersResponse {
  users: UserSummary[];
}

// ---------------------------------------------------------------------------
// Profiles — one workspace member as a work record (identity, what is open on
// them, what they have touched). Workspace-scoped because activity_log is: a
// profile answers "who is this, here", never "who is this, everywhere".
// ---------------------------------------------------------------------------

/** A page this person has written on, newest touch first. */
export interface ProfilePage {
  documentId: string;
  title: string;
  category: string;
  projectId: string;
  /** Head-revision status, for the lifecycle dot. */
  status: RevisionStatus | null;
  /** True when this person created the document, not merely revised it. */
  authored: boolean;
  revisions: number;
  lastTouchedAt: string;
}

/** Work still owed, in the product's own terms. */
export interface ProfileOpenWork {
  /** Merge requests they opened that are still open. */
  authoredMergeRequests: number;
  /** Open merge requests where they are a reviewer and have not approved. */
  awaitingTheirReview: number;
  /** Unresolved, resolvable threads they have commented in. */
  unresolvedThreads: number;
}

// GET /v1/profiles/:userId?workspaceId=
export interface UserProfileResponse {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  /** Platform admin (users.is_admin). */
  isAdmin: boolean;
  disabled: boolean;
  /** users.created_at — when the account was made, not when they joined here. */
  createdAt: string;
  /** Null when the subject is not a member of this workspace (a platform admin looking in). */
  role: WorkspaceRole | null;
  trustedOperator: boolean;
  /** workspace_members.created_at — when they joined THIS workspace. */
  memberSince: string | null;
  /** True when this profile is the caller's own. */
  isSelf: boolean;
  hasPassword: boolean;
  hasApiKey: boolean;
  pages: ProfilePage[];
  /** Distinct documents they have revised in this workspace (pages[] is capped). */
  pageCount: number;
  openWork: ProfileOpenWork;
}

// POST /v1/me/api-key — rotate the caller's key; the plaintext is shown once.
export interface RotateApiKeyResponse {
  /** `kn_…`. Never retrievable again — only its SHA-256 is stored. */
  apiKey: string;
  rotatedAt: string;
}

// ---------------------------------------------------------------------------
// API keys (docs/features/33) — many named keys per person, each optionally
// narrowed. A key can only ever do less than the person who minted it: the
// narrowing is applied on top of their workspace role, never instead of it.
// ---------------------------------------------------------------------------

/**
 * `read` caps every workspace at the viewer role; `write` leaves the owner's
 * own role in force. `capture` (issue #73) reads like `read` and may also
 * propose — the agent-memory tools and routes, which only ever open a merge
 * request — but never write, merge, approve or sync. Narrowest first. Closed:
 * the guard, the form and the MCP tool filter all read this one list.
 */
export const API_KEY_SCOPES = ['read', 'capture', 'write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * The scope a stored `api_keys.scope` grants. Anything this release does not
 * know reads as `read` — the narrowest — so a value from a newer release, or
 * a typo in a hand-edited row, can never widen a key.
 */
export function apiKeyScopeOf(stored: string): ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(stored) ? (stored as ApiKeyScope) : 'read';
}

/** How many projects a `capture` key may be pinned to. */
export const API_KEY_MAX_PROJECTS = 20;

export interface ApiKeyInfo {
  id: string;
  name: string;
  /** The first characters of the key (`kn_1a2b3c4d`), enough to recognise it in a config file. */
  prefix: string;
  scope: ApiKeyScope;
  /** Pinned to one workspace, or null for every workspace the owner belongs to. */
  workspaceId: string | null;
  /**
   * A `capture` key pinned to these projects: it may propose into them and no
   * other (issue #73). Null for every project. Reads are not narrowed by it.
   */
  projectIds: string[] | null;
  expiresAt: string | null;
  /** Coarse — refreshed at most once a minute, so it answers "is this still in use", not "when exactly". */
  lastUsedAt: string | null;
  createdAt: string;
}

// GET /v1/me/api-keys
export interface ListApiKeysResponse {
  keys: ApiKeyInfo[];
}

// POST /v1/me/api-keys — the plaintext is in this response and nowhere else, ever.
export interface CreateApiKeyResponse {
  key: ApiKeyInfo;
  /** `kn_…`. Only its SHA-256 is stored. */
  apiKey: string;
}

// ---------------------------------------------------------------------------
// MCP over HTTP (docs/features/33) — what a client needs to connect.
// ---------------------------------------------------------------------------

export interface McpToolSummary {
  name: string;
  description: string;
  /** Mirrors the tool's MCP `readOnlyHint`: false means it can change the knowledge base. */
  readOnly: boolean;
}

// GET /v1/mcp/connection
export interface McpConnectionInfo {
  /** Streamable HTTP endpoint, absolute — this is what goes into a client's config. */
  url: string;
  /** The server key used in every generated config snippet. */
  serverName: string;
  /** 'none' means the server accepts any caller as the dev principal and no key is needed. */
  authMode: 'none' | 'api-key';
  version: string;
  /** Tools the calling credential would be offered. */
  tools: McpToolSummary[];
}



// ---------------------------------------------------------------------------
// Access control management (workspace members)
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  createdAt: string;
  memberCount: number;
  /** Caller's role in this workspace (null for platform admins listing foreign workspaces). */
  myRole: WorkspaceRole | null;
}

// GET /v1/workspaces
export interface ListWorkspacesResponse {
  workspaces: WorkspaceSummary[];
}

export interface CreateWorkspaceResponse {
  workspaceId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Projects — the organizational layer between a workspace and its documents.
// Projects carry no ACLs of their own: access is resolved at the workspace.
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  projectId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  /** An uploaded picture. Null when the project uses an emoji, or neither. */
  avatarUrl: AvatarUrl;
  /**
   * A chosen emoji, drawn on `avatarColor`. Null when the project has a picture
   * or neither — the three states are exclusive, and the API clears whichever
   * one the write did not set.
   *
   * Worth offering beside an upload because a project tile is 20px in the
   * sidebar, where an emoji stays legible and a scaled-down photograph does not.
   */
  avatarEmoji: string | null;
  /** Backs the emoji only; an image brings its own colours. Hex, e.g. `#3b82f6`. */
  avatarColor: string | null;
  /** Pages in it the caller may open. */
  documentCount: number;
  createdAt: string;
  /** Only grantees (and admins) open it or anything in it (#76). */
  restricted?: boolean;
}

export interface ListProjectsResponse {
  projects: ProjectSummary[];
  /** Always null when the request carried no `limit`. */
  nextCursor: string | null;
}

export interface CreateProjectResponse {
  project: ProjectSummary;
}


// ---------------------------------------------------------------------------
// Deleting a project — GET /v1/projects/:id/deletion-preview,
// DELETE /v1/projects/:id?moveContentsTo=
//
// Removal is *move-then-delete*, not a cascade. Documents are never deleted
// anywhere in this product — revisions are immutable and the S3 keys, graph
// vertices, chunks and merge requests all hang off them — so a project's
// contents are reassigned to a sibling project and the emptied project is then
// dropped. Since a workspace always keeps at least one project, a non-empty
// project always has somewhere to move to.
//
// The preview exists so the warning can name what is about to move before it
// moves. It is derived on every request with no stored table, exactly as
// ProjectOverviewResponse is.
// ---------------------------------------------------------------------------

/** What a project holds, and therefore what a deletion has to relocate. */
export interface ProjectDeletionCounts {
  documents: number;
  glossaryTerms: number;
  connectors: number;
  workflowDefinitions: number;
  /**
   * Runs that are `pending | running | awaiting-review | paused` — work a move
   * relocates mid-flight, which is worth saying out loud before it happens.
   */
  activeWorkflowRuns: number;
  /** Imports still `awaiting-upload | queued | running`: their destination changes under them. */
  pendingImports: number;
  /**
   * People watching the project itself. Not moved and not blocking — the
   * subscriptions go away with their subject — but disclosed, because those
   * people stop hearing about this work without ever pressing anything.
   */
  watchers: number;
}

/**
 * How a project's contents are dealt with.
 *
 * `move` is the safe default and the shape the product is built for: pages are
 * never deleted, so they are reassigned to a sibling project. `cascade`
 * destroys them along with everything downstream — revisions, stored files,
 * merge requests, discussions, workflow runs, graph vertices and search index
 * entries — and is the only operation in the product that removes a page at
 * all. It is irreversible and there is no undo, so it is gated on echoing the
 * project's name back (`confirm`), server-side, not only in the dialog.
 */
export const PROJECT_DELETION_MODES = ['move', 'cascade'] as const;
export type ProjectDeletionMode = (typeof PROJECT_DELETION_MODES)[number];

/**
 * What a cascade destroys, beyond the holdings a move would relocate.
 *
 * Reported separately from `ProjectDeletionCounts` because these are the
 * numbers that make the difference between the two modes legible: a project
 * with 12 pages is also 300 revisions and 340 files in object storage, and the
 * second number is the one that says what "delete everything" costs.
 */
export interface ProjectCascadeCounts {
  documents: number;
  revisions: number;
  attachments: number;
  mergeRequests: number;
  /** Review threads and page comment threads together — every discussion lost. */
  discussions: number;
  workflowRuns: number;
  /** Objects in storage: each revision's source and normalized JSON, plus attachments. */
  storedFiles: number;
}

export interface ProjectDeletionPreview {
  projectId: string;
  name: string;
  /** Holds nothing at all, so it can be deleted outright with no destination. */
  empty: boolean;
  /**
   * The workspace's only project. Nothing can be done about this one: the next
   * page created would have nowhere to go, so the delete is refused whatever
   * the project holds.
   */
  lastInWorkspace: boolean;
  counts: ProjectDeletionCounts;
  /**
   * Terms this project defines that the destination already defines.
   * `glossary_terms` is unique on `(project_id, term)`, so both cannot survive
   * the move: the destination's definition wins and these rows are dropped.
   * Empty unless the request named a `target`.
   */
  glossaryConflicts: string[];
  /**
   * What choosing `cascade` would destroy. Always present, so the dialog can
   * show the price of the destructive option without a second round trip —
   * the point of the preview is that both choices are legible before either is
   * taken.
   */
  cascade: ProjectCascadeCounts;
}


export interface DeleteProjectResponse {
  deleted: true;
  mode: ProjectDeletionMode;
  /** The project its contents were moved into. Null on a cascade, or when empty. */
  movedTo: string | null;
  /** What actually moved. Zeroes throughout on a cascade, or when empty. */
  moved: ProjectDeletionCounts;
  /** What was destroyed. Null unless the mode was `cascade`. */
  destroyed: ProjectCascadeCounts | null;
  /** Terms dropped in favour of the destination's own definition. */
  droppedGlossaryTerms: string[];
}

// ---------------------------------------------------------------------------
// GET /v1/projects/:id/overview — what a project *is*, for the page you read
// rather than the form you edit it in.
//
// Derived on every request, with no stored table, exactly as UserProfileResponse
// is: every number here is a count over rows that already exist, and a cached
// copy would only introduce a second answer to the same question.
// ---------------------------------------------------------------------------

/**
 * Someone who has worked in this project.
 *
 * Derived, never assigned. Projects hold no members and are not going to
 * (docs/features/11: "organizational only") — a second ACL layer under the
 * workspace boundary would be a new authorization surface for no gain. So the
 * people shown here are the people who have actually revised a page in it,
 * which has the useful property of staying true without anyone maintaining it.
 *
 * Ids only: names and faces come from the workspace-member roster the client
 * already has cached, so this endpoint never re-sends them.
 */
export interface ProjectContributor {
  userId: string;
  /** Distinct pages in this project they have authored a revision of. */
  pageCount: number;
  /** Their most recent revision here. */
  lastActiveAt: string;
}

export interface ProjectOverviewResponse {
  project: ProjectSummary;
  contributors: ProjectContributor[];
  counts: {
    documents: number;
    glossaryTerms: number;
    connectors: number;
    workflows: number;
    openMergeRequests: number;
  };
  /** Most recently updated pages, capped — the rail links out for the rest. */
  recentPages: { documentId: string; title: string; updatedAt: string }[];
}

// ---------------------------------------------------------------------------
// Avatars. The same three-step upload page attachments use, for the same
// reason: the bytes go straight to object storage on a presigned URL, so a
// picture never streams through Node. `POST …/avatar` reserves and answers with
// the URL to PUT to; `POST …/avatar/complete` is what makes it the live face,
// after the API has confirmed the bytes actually arrived.
// ---------------------------------------------------------------------------

/** Image types an avatar may be. Checked at reserve time, before any bytes move. */
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/**
 * 2 MB. Smaller than a page attachment on purpose: this is a face rendered at
 * 28px, and the cost of a large one is paid on every screen that lists people.
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

// POST /v1/me/avatar · POST /v1/projects/:id/avatar
export interface CreateAvatarUploadRequest {
  filename: string;
  contentType: AvatarContentType;
  sizeBytes: number;
}
export interface CreateAvatarUploadResponse {
  /**
   * Names this attempt. Echoed back on complete, so the API can rebuild the
   * object key it signed rather than trusting a key from the client — the same
   * reason attachments reserve a row before the bytes exist.
   */
  uploadId: string;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

export interface CompleteAvatarUploadResponse {
  avatarUrl: AvatarUrl;
}

export interface WorkspaceMemberEntry {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  role: WorkspaceRole;
  trustedOperator: boolean;
  /** Granted by hand (#468); editable on any row, since no IdP manages it. */
  capabilities: MemberCapability[];
  /** Who manages the row (#75). Only `manual` rows are edited by hand; the rest need `convertToManual`. */
  source: MembershipSource;
  disabled: boolean;
  createdAt: string;
}

// GET /v1/workspaces/:id/members
export interface ListWorkspaceMembersResponse {
  workspaceId: string;
  members: WorkspaceMemberEntry[];
}

/**
 * A user who is *not* yet a member of the workspace — what the add-member
 * picker searches. Deliberately thinner than {@link UserSummary}: workspace
 * admins are not platform admins, so they see identity only, never
 * credentials, the platform-admin flag or foreign memberships.
 */
export interface WorkspaceCandidate {
  userId: string;
  email: string;
  displayName: string;
  /** Disabled accounts cannot authenticate; adding one is legal but inert. */
  disabled: boolean;
}

// GET /v1/workspaces/:id/candidates?q=&limit=
export interface ListWorkspaceCandidatesResponse {
  workspaceId: string;
  candidates: WorkspaceCandidate[];
}

// ---------------------------------------------------------------------------
// User groups (#76): workspace-scoped sets of members that page and project
// restrictions grant to. Membership is manual today; `connector` groups are
// mirrored from a source by ACL sync and `scim` ones by provisioning, and both
// are read-only over the API — a manual edit would be overwritten next sync.

export const GROUP_SOURCES = ['manual', 'connector', 'scim'] as const;
export type GroupSource = (typeof GROUP_SOURCES)[number];

export interface UserGroupSummary {
  groupId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  source: GroupSource;
  memberCount: number;
  createdAt: string;
}

// GET /v1/groups?workspaceId=
export interface ListUserGroupsResponse {
  workspaceId: string;
  groups: UserGroupSummary[];
}

export interface UserGroupMemberEntry {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: AvatarUrl;
  /** The person's workspace role — a guest in a group still reads only what the group is granted. */
  role: WorkspaceRole;
  source: GroupSource;
  createdAt: string;
}

// GET /v1/groups/:id/members · PUT /v1/groups/:id/members
export interface ListUserGroupMembersResponse {
  groupId: string;
  members: UserGroupMemberEntry[];
}

// ---------------------------------------------------------------------------
// Page and project restrictions (#76, phase 2).
//
// A project or page is *restricted* when its own switch is on. A reader must be
// admitted by every restricted node on the chain project → root → … → page, so
// restricting a parent hides its whole subtree and a child can only narrow.
// Grants on an unrestricted node admit nobody new to the workspace's members;
// they are how a guest reaches a page and how edit/manage are handed out.
// The workspace role stays the ceiling: a viewer with an `edit` grant still
// reads only. Workspace admins see and manage everything.

export const ACCESS_LEVELS = ['view', 'edit', 'manage'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
/** What a caller may do with one page or project; `none` = they may not open it. */
export type EffectiveAccessLevel = AccessLevel | 'none';

/** none < view < edit < manage, for comparing two levels without a lookup table at each site. */
export function accessRank(level: EffectiveAccessLevel): number {
  return level === 'none' ? -1 : ACCESS_LEVELS.indexOf(level);
}

export const ACCESS_RESOURCE_TYPES = ['project', 'document'] as const;
export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number];

export const ACCESS_SUBJECT_TYPES = ['user', 'group'] as const;
export type AccessSubjectType = (typeof ACCESS_SUBJECT_TYPES)[number];

export interface AccessGrantInput {
  subjectType: AccessSubjectType;
  subjectId: string;
  level: AccessLevel;
}

/**
 * Who wrote a grant. `manual` rows are a manager's, replaced by `PUT …/access`;
 * `connector` rows mirror an upstream ACL (#76, phase 6) and are rewritten
 * only by that connector's sync, so the dialog shows them read-only and never
 * sends them back.
 */
export const ACCESS_GRANT_ORIGINS = ['manual', 'connector'] as const;
export type AccessGrantOrigin = (typeof ACCESS_GRANT_ORIGINS)[number];

export interface AccessGrantEntry extends AccessGrantInput {
  origin: AccessGrantOrigin;
  /** The connector a `connector` grant came from; null for manual ones. */
  connectorId: string | null;
  /** The group's name or the person's display name; null when the subject is gone. */
  name: string | null;
  /** People only. */
  email: string | null;
  avatarUrl: AvatarUrl;
  /** Groups only. */
  memberCount: number | null;
}

/** A restricted node above the one being looked at, which every reader must also pass. */
export interface InheritedRestriction {
  resourceType: AccessResourceType;
  resourceId: string;
  /** Null when the caller may not open that node — a guest's ungranted ancestor. */
  title: string | null;
  grantCount: number;
}

// GET /v1/documents/:id/access · GET /v1/projects/:id/access
export interface ResourceAccessResponse {
  resourceType: AccessResourceType;
  resourceId: string;
  restricted: boolean;
  /** Outermost first: the project, then ancestors root-first. Empty when nothing above is restricted. */
  inherited: InheritedRestriction[];
  /** What the caller may do here. */
  level: EffectiveAccessLevel;
  canManage: boolean;
  /** Grants on this node itself. Empty unless `canManage`: who holds what is a manager's business. */
  grants: AccessGrantEntry[];
}

// PUT /v1/documents/:id/access · PUT /v1/projects/:id/access
export interface UpdateResourceAccessRequest {
  restricted: boolean;
  /** Replaces the node's grants as a whole. */
  grants: AccessGrantInput[];
}

/** Why someone holds the level they do. */
export const EFFECTIVE_ACCESS_SOURCES = ['admin', 'role', 'grant'] as const;
export type EffectiveAccessSource = (typeof EFFECTIVE_ACCESS_SOURCES)[number];

export interface EffectiveAccessEntry {
  userId: string;
  displayName: string;
  email: string;
  avatarUrl: AvatarUrl;
  role: WorkspaceRole;
  level: AccessLevel;
  /** `admin`: workspace admin; `role`: the workspace role decides; `grant`: a user or group grant does. */
  source: EffectiveAccessSource;
}

// GET /v1/documents/:id/access/effective · GET /v1/projects/:id/access/effective
export interface EffectiveAccessResponse {
  resourceType: AccessResourceType;
  resourceId: string;
  /** Everyone who may open it, highest level first. */
  entries: EffectiveAccessEntry[];
}

// ---------------------------------------------------------------------------
// Access requests (#76, phase 5): somebody refused a page or project asks for a
// level on it; whoever manages it approves (choosing the level) or denies.
// A pending request expires after ACCESS_REQUEST_TTL_DAYS.

export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'cancelled', 'expired'] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** A level a person may ask for: manage is handed out, never requested. */
export const REQUESTABLE_ACCESS_LEVELS = ['view', 'edit'] as const;
export type RequestableAccessLevel = (typeof REQUESTABLE_ACCESS_LEVELS)[number];

export interface AccessRequestPerson {
  userId: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: AvatarUrl;
}

export interface AccessRequestEntry {
  requestId: string;
  workspaceId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  /**
   * The page or project name — for its managers, who can open it, and for the
   * requester once approved. Null for a requester who still cannot open it:
   * asking for a page is not a way to learn what it is called.
   */
  resourceTitle: string | null;
  requester: AccessRequestPerson;
  level: RequestableAccessLevel;
  message: string | null;
  status: AccessRequestStatus;
  decidedBy: AccessRequestPerson | null;
  decidedLevel: AccessLevel | null;
  decidedAt: string | null;
  /** Why a request was denied, when the manager said. */
  reason: string | null;
  /** When a pending request lapses. */
  expiresAt: string;
  createdAt: string;
  /** Whether the caller may approve or deny it. */
  canDecide: boolean;
}

// POST /v1/access-requests
export interface CreateAccessRequestRequest {
  workspaceId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  level: RequestableAccessLevel;
  message?: string | null;
}

// GET /v1/access-requests?workspaceId=&status=&mine=&resourceType=&resourceId=
export interface ListAccessRequestsResponse {
  workspaceId: string;
  requests: AccessRequestEntry[];
}

// POST /v1/access-requests/:id/approve
export interface ApproveAccessRequestRequest {
  /** Defaults to the level asked for; a manager may hand out less, or more up to the requester's ceiling. */
  level?: AccessLevel;
}

// POST /v1/access-requests/:id/deny
export interface DenyAccessRequestRequest {
  reason?: string | null;
}

/**
 * What a posted comment adds to its thread response (#76, phase 5): the people
 * it named who cannot open the page. They were not notified; the editor offers
 * a manager "Grant view" and everyone else "Ask a manager".
 */
export interface MentionAccessNote {
  mentionedWithoutAccess: string[];
}



// ---------------------------------------------------------------------------
// Strict error contract
