import type { AvatarUrl, Locale, WorkspaceRole } from '@knowledge/contracts';

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
   * Stored UI + API language (users.locale, docs/features/18). Not what a given
   * request is answered in — nestjs-i18n resolves that from ?lang=/cookie/header
   * in middleware, before this principal exists. This is the durable preference
   * the web mirrors into kn_lang at sign-in.
   */
  locale: Locale;
  /** Set when authenticated via a ks_ session token — lets logout revoke exactly this session. */
  sessionId?: string;
}

/** AUTH_MODE=none principal. Matches the Phase 1 author stub id on purpose. */
export const DEV_PRINCIPAL: Principal = {
  userId: '00000000-0000-0000-0000-000000000000',
  email: 'dev@localhost',
  displayName: 'Dev (AUTH_MODE=none)',
  // No users row to hang a picture on; the initials face is correct here.
  avatarUrl: null,
  mode: 'dev',
  isAdmin: true,
  locale: 'en',
};

/** Role hierarchy: higher number ⇒ more rights. */
export const ROLE_ORDER: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, admin: 2 };
