import type { WorkspaceRole } from '@knowledge/contracts';

/**
 * Resolved caller identity (Phase 5, plan.md §11). Attached to the request by
 * AuthGuard; workspace-level rights are checked separately by AclGuard via
 * AccessService (membership lives in PostgreSQL — the ACL source of truth).
 */
export interface Principal {
  /** users.id in api-key mode; the synthetic dev id in AUTH_MODE=none. */
  userId: string;
  email: string;
  displayName: string;
  /** 'dev' = AUTH_MODE=none — admin + trusted operator everywhere, keeps Phase 0-4 flows working. */
  mode: 'dev' | 'api-key';
}

/** AUTH_MODE=none principal. Matches the Phase 1 author stub id on purpose. */
export const DEV_PRINCIPAL: Principal = {
  userId: '00000000-0000-0000-0000-000000000000',
  email: 'dev@localhost',
  displayName: 'Dev (AUTH_MODE=none)',
  mode: 'dev',
};

/** Role hierarchy: higher number ⇒ more rights. */
export const ROLE_ORDER: Record<WorkspaceRole, number> = { viewer: 0, editor: 1, admin: 2 };
