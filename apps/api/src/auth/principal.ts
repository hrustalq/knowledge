import type { ApiKeyScope, AuthMethod, AvatarUrl, Locale, McpToolset, WorkspaceRole } from '@knowledge/contracts';
import { AUTHOR_ID_STUB } from '../activity/actor.js';

/**
 * Resolved caller identity (Phase 5, plan.md §11). Attached to the request by
 * AuthGuard; workspace-level rights are checked separately by AclGuard via
 * AccessService (membership lives in PostgreSQL — the ACL source of truth).
 */
export interface Principal {
  /** users.id in api-key/session mode; synthetic dev id in AUTH_MODE=none. */
  userId: string;
  email: string;
  displayName: string;
  /**
   * The caller's own picture, or null when their face is drawn from initials.
   *
   * Carried on the principal because three separate places answer GET /v1/me
   * from one, and the topbar avatar is the first thing rendered on every page —
   * asking for it separately would be a second round trip for something the
   * session lookup already read.
   */
  avatarUrl: AvatarUrl;
  /** 'dev' = AUTH_MODE=none — admin + trusted operator everywhere, keeps Phase 0-4 flows working. */
  mode: 'dev' | 'api-key' | 'session';
  /** Platform admin (users.is_admin): user management + implicit admin in every workspace. */
  isAdmin: boolean;
  /**
   * The language this caller is answered in by everything that reads the
   * principal — model replies, flow forms, deferred work started now (#1185).
   * Resolved from users.locale (docs/features/18); on an HTTP request `AuthGuard`
   * replaces it with the language the request names (?lang= -> kn_lang ->
   * Accept-Language), the same order errors are answered in, so a client never
   * gets errors in one language and answers in another.
   */
  locale: Locale;
  /**
   * users.locale when `AuthGuard` replaced `locale` with the request's language:
   * the durable preference `GET /v1/me` reports and the web mirrors into kn_lang
   * at sign-in. Absent means `locale` is still the stored value.
   */
  savedLocale?: Locale;
  /**
   * users.email_verified_at is set (docs/features/41). Absent means not
   * applicable — the dev principal and an agent's run owner — and reads as
   * verified, so only a real account can be held up by it.
   */
  emailVerified?: boolean;
  /** Set when authenticated via a ks_ session token — lets logout revoke exactly this session. */
  sessionId?: string;
  /**
   * How that session was opened (#75), and through which identity provider.
   * Set only for a session: enforced SSO reads them to tell a password session
   * from one its own IdP issued.
   */
  authMethod?: AuthMethod;
  providerId?: string;
  /** When that session was opened (ISO; it survives a `kt_` ticket's JSON) — a workspace's age cap reads it. */
  sessionCreatedAt?: string;
  /**
   * Set when authenticated via a `kn_` key (docs/features/33): what that key
   * narrows the person down to. Enforced in AccessService.requireRole, so every
   * `@Access` route and every MCP tool applies it without knowing it exists.
   */
  apiKey?: {
    id: string;
    scope: ApiKeyScope;
    workspaceId: string | null;
    projectIds?: string[] | null;
    /**
     * The MCP toolsets the key is limited to (#945); absent or null for every
     * toolset. A key with a list is MCP-only: `TokenAuthService.resolve`
     * refuses it at every door that does not say it is the MCP endpoint.
     */
    toolsets?: McpToolset[] | null;
    /**
     * Set when the bearer was a `ko_` OAuth access token (#1352): the row is a
     * grant a person approved on the consent screen, not a key. MCP-only like a
     * toolset list, and judged by enforced SSO as the sign-in that approved it.
     */
    oauth?: { clientId: string; signInMethod: AuthMethod | null; signInProviderId: string | null; grantedAt: string };
    /**
     * A Connect wizard setup key (#1371): `TokenAuthService.resolve` refuses it
     * at every door but the installer routes (`@InstallKeyOk`).
     */
    install?: true;
  };
}

/** AUTH_MODE=none principal. Matches the Phase 1 author stub id on purpose. */
export const DEV_PRINCIPAL: Principal = {
  userId: AUTHOR_ID_STUB,
  email: 'dev@localhost',
  displayName: 'Dev (AUTH_MODE=none)',
  // No users row to hang a picture on; the initials face is correct here.
  avatarUrl: null,
  mode: 'dev',
  isAdmin: true,
  locale: 'en',
};

/**
 * Role hierarchy: higher number ⇒ more rights. `guest` is below every route's
 * minimum, so `requireRole(…, 'viewer')` refuses a guest with no special case
 * (#76) — what a guest may open is decided per page, not by this ladder.
 */
export const ROLE_ORDER: Record<WorkspaceRole, number> = { guest: -1, viewer: 0, editor: 1, admin: 2 };

/**
 * A `workspace_members` filter for the people who read the workspace as a
 * whole — every role but guest. For the places that ask "is this person a
 * member" directly instead of through `requireRole` (mention recipients,
 * reviewers, page owners, site audiences), where a bare membership row would
 * otherwise let a guest in.
 */
export const WORKSPACE_READER = { role: { not: 'guest' } } as const;

/** What `@PlatformAdmin()` admits: a platform admin, or the dev principal. */
export function isPlatformAdmin(principal: Principal): boolean {
  return principal.mode === 'dev' || principal.isAdmin;
}
