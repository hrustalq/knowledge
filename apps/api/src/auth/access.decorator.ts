import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { MemberCapability, WorkspaceFeature, WorkspaceRole } from '@knowledge/contracts';

export const ACCESS_META = 'knowledge:access';
export const PUBLIC_META = 'knowledge:public';
export const PLATFORM_ADMIN_META = 'knowledge:platform-admin';
export const READ_KEY_OK_META = 'knowledge:read-key-ok';
export const QUERY_TOKEN_OK_META = 'knowledge:query-token-ok';
export const UNVERIFIED_OK_META = 'knowledge:unverified-ok';
export const FEATURE_META = 'knowledge:feature';

/** Where AclGuard finds the workspace id for a route (resolved in PostgreSQL). */
export type WorkspaceSource =
  | 'body' // request body carries workspaceId
  | 'query' // ?workspaceId=
  | 'document' // :id path param is a document id
  | 'merge-request' // :id path param is a merge request id
  | 'job' // :id path param is an ingestion job id
  | 'project' // :id path param is a project id (resolved to its workspace)
  | 'assistant-thread' // :id path param is an assistant chat thread id
  | 'assistant-message' // :id path param is an assistant chat message id (resolved through its thread; docs/features/38)
  | 'knowledge-issue' // :id path param is a knowledge issue id (docs/features/38, phase 3)
  | 'ai-skill' // :id path param is an AI skill id
  | 'ai-plugin' // :id path param is an AI plugin (MCP server) id
  | 'ai-provider' // :id path param is an AI provider profile id
  | 'agent-trigger' // :id path param is an agent trigger id (#70)
  | 'agent-learning' // :id path param is an agent learning id (#70)
  | 'glossary-term' // :id path param is a glossary term id
  | 'source-policy' // :id path param is a web source policy id (docs/features/25)
  | 'saved-filter' // :filterId path param is a saved merge-request filter id (integer)
  | 'import' // :id path param is an import job id (docs/features/16)
  | 'memo' // :id path param is a memo id (#551; ownership is the service's)
  | 'workflow-definition' // :id path param is a workflow definition id (docs/features/17)
  | 'workflow-run' // :id path param is a workflow run id (docs/features/17)
  | 'template' // :id path param is a page template id (issue #69)
  | 'share-link' // :id path param is a share link id (docs/features/43)
  | 'site' // :id path param is a published site id (docs/features/44)
  | 'site-version' // :id path param is a site version id (resolved through its site; docs/features/44)
  | 'site-domain' // :id path param is a site domain id (resolved through its site; docs/features/44)
  | 'export' // :id path param is an export job id (docs/features/45)
  | 'connector' // :id path param is a connector id (docs/features/19)
  | 'connector-run' // :runId path param is a connector run id (docs/features/19)
  | 'connection' // :id path param is a connection id (#564)
  | 'chat-integration' // :id path param is a chat bot id (issue #71)
  | 'chat-binding' // :id path param is a chat channel binding id (issue #71)
  | 'chat-subscription' // :id path param is a chat subscription id (issue #71, phase 3)
  | 'group' // :id path param is a user group id (issue #76)
  | 'access-request' // :id path param is an access request id (issue #76, phase 5)
  | 'capture' // :id path param is a knowledge capture id (issue #73, phase 3)
  | 'release-tag' // :id path param is a release tag id (issue #81, phase 2)
  | 'conflict' // :id path param is a knowledge conflict id (issue #81, phase 5)
  | 'workspace'; // :id path param IS the workspace id (existence-checked)

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
