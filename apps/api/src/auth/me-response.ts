import { memberCapabilitiesOf, membershipSourceOf, type MeResponse, type WorkspaceRole } from '@knowledge/contracts';
import type { WorkspaceMember } from '@prisma/client';
import type { Principal } from './principal.js';

/**
 * GET /v1/me, PATCH /v1/me and signup/login all answer with the same identity.
 * One builder, because a field added to `MeResponse` and missed in one of
 * three copies is a client that sees it only after a reload.
 */
export function toMeResponse(
  principal: Principal,
  memberships: Pick<WorkspaceMember, 'workspaceId' | 'role' | 'trustedOperator' | 'capabilities' | 'source'>[],
  verificationRequired: boolean,
): MeResponse {
  return {
    userId: principal.userId,
    email: principal.email,
    displayName: principal.displayName,
    avatarUrl: principal.avatarUrl,
    mode: principal.mode,
    isAdmin: principal.isAdmin,
    locale: principal.locale,
    authMethod: principal.mode === 'session' ? (principal.authMethod ?? 'password') : null,
    emailVerified: principal.emailVerified ?? true,
    emailVerificationRequired: verificationRequired,
    memberships: memberships.map((m) => ({
      workspaceId: m.workspaceId,
      role: m.role as WorkspaceRole,
      trustedOperator: m.trustedOperator,
      capabilities: memberCapabilitiesOf(m.capabilities),
      source: membershipSourceOf(m.source),
    })),
  };
}
