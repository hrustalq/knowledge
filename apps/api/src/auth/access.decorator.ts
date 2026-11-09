import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MemberCapability, WorkspaceFeature, WorkspaceRole } from '@knowledge/contracts';
import type { RowSource } from './workspace-sources.js';

export const ACCESS_META = 'knowledge:access';
export const PUBLIC_META = 'knowledge:public';
export const PLATFORM_ADMIN_META = 'knowledge:platform-admin';
export const READ_KEY_OK_META = 'knowledge:read-key-ok';
export const QUERY_TOKEN_OK_META = 'knowledge:query-token-ok';
export const UNVERIFIED_OK_META = 'knowledge:unverified-ok';
export const FEATURE_META = 'knowledge:feature';

/**
 * Where AclGuard finds the workspace id for a route (resolved in PostgreSQL):
 * the request body's or query's `workspaceId`, the `:id` param as the
 * workspace itself (existence-checked), or a row named by a path param —
 * one row in `WORKSPACE_SOURCES` per resource.
 */
export type WorkspaceSource = 'body' | 'query' | 'workspace' | RowSource;

export interface AccessSpec {
  role: WorkspaceRole;
  source: WorkspaceSource;
  /** Additionally require workspace_members.trusted_operator (plan.md §9). */
  operator: boolean;
  /**
   * A guest passes this workspace-level `viewer` route (#76). Only for a
   * handler that filters everything it returns through the caller's
   * `AccessScope` — a guest otherwise reads the whole workspace through it.
   * Absent unless set, so every other route's metadata reads as it always did.
   */
  guests?: true;
  /**
   * A `capture` API key passes this `editor` route (issue #73). Only for a
   * route that stages a capture and at most opens a merge request — never one
   * that writes a default branch, merges or approves. Absent unless set.
   */
  capture?: true;
  /**
   * Additionally require a member capability (#468), like `operator` but
   * from the closed MEMBER_CAPABILITIES catalogue. Absent unless set.
   */
  capability?: MemberCapability;
}

/** Declare a route's ACL: minimum workspace role + where the workspace id comes from. */
export const Access = (
  role: WorkspaceRole,
  source: WorkspaceSource,
  opts?: { operator?: boolean; guests?: boolean; capture?: boolean; capability?: MemberCapability },
) =>
  SetMetadata(ACCESS_META, {
    role,
    source,
    operator: opts?.operator ?? false,
    ...(opts?.guests ? { guests: true as const } : {}),
    ...(opts?.capture ? { capture: true as const } : {}),
    ...(opts?.capability ? { capability: opts.capability } : {}),
  } satisfies AccessSpec);

/** Route reachable without authentication (health checks, login/signup/reset). */
export const Public = () => SetMetadata(PUBLIC_META, true);

/**
 * The route belongs to a section a workspace admin may switch off (#604). On a
 * controller or a handler; AclGuard answers 404 when the route's workspace has
 * it off. Needs `@Access`, which is how the guard finds the workspace — and
 * that runs even under AUTH_MODE=none, so a toggle behaves the same in dev.
 */
export const Feature = (feature: WorkspaceFeature) => SetMetadata(FEATURE_META, feature);

/** Route restricted to platform admins (users.is_admin) — user management surface. */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN_META, true);

/**
 * A route with no `@Access` that a read-only API key may still call with a
 * non-GET method, because the method is transport rather than intent. The MCP
 * endpoint is the case: every JSON-RPC call is a POST, and each tool behind it
 * runs its own `requireRole` (docs/features/33).
 */
export const ReadKeyOk = () => SetMetadata(READ_KEY_OK_META, true);

/**
 * A route that may authenticate with `?token=` instead of an `Authorization`
 * header (#102). Only for `EventSource` (the SSE stream), which cannot set
 * headers, and only with a single-use `kt_` ticket. Everywhere else AuthGuard
 * ignores the query token, so a key pasted into a URL authenticates nothing:
 * URLs end up in access logs, browser history and `Referer` headers. The
 * allowlist is pinned by test/query-token.spec.ts, so adding a route here is a
 * reviewed decision.
 */
export const QueryTokenOk = () => SetMetadata(QUERY_TOKEN_OK_META, true);

/**
 * A route a session with an unproven address may still call while
 * AUTH_REQUIRE_VERIFIED_EMAIL is on (docs/features/41): the ones it needs to
 * see who it is, change its language, sign out and ask for the link again.
 * Everything else answers 403 `emailUnverified` until the link is followed.
 */
export const UnverifiedOk = () => SetMetadata(UNVERIFIED_OK_META, true);

/** Injects the Principal that AuthGuard attached to the request. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().principal,
);
