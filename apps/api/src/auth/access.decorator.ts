import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { WorkspaceRole } from '@knowledge/contracts';

export const ACCESS_META = 'knowledge:access';
export const PUBLIC_META = 'knowledge:public';
export const PLATFORM_ADMIN_META = 'knowledge:platform-admin';

/** Where AclGuard finds the workspace id for a route (resolved in PostgreSQL). */
export type WorkspaceSource =
  | 'body' // request body carries workspaceId
  | 'query' // ?workspaceId=
  | 'document' // :id path param is a document id
  | 'merge-request' // :id path param is a merge request id
  | 'job' // :id path param is an ingestion job id
  | 'workspace'; // :id path param IS the workspace id (existence-checked)

export interface AccessSpec {
  role: WorkspaceRole;
  source: WorkspaceSource;
  /** Additionally require workspace_members.trusted_operator (plan.md §9). */
  operator: boolean;
}

/** Declare a route's ACL: minimum workspace role + where the workspace id comes from. */
export const Access = (role: WorkspaceRole, source: WorkspaceSource, opts?: { operator?: boolean }) =>
  SetMetadata(ACCESS_META, { role, source, operator: opts?.operator ?? false } satisfies AccessSpec);

/** Route reachable without authentication (health checks, login/signup/reset). */
export const Public = () => SetMetadata(PUBLIC_META, true);

/** Route restricted to platform admins (users.is_admin) — user management surface. */
export const PlatformAdmin = () => SetMetadata(PLATFORM_ADMIN_META, true);

/** Injects the Principal that AuthGuard attached to the request. */
export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().principal,
);
