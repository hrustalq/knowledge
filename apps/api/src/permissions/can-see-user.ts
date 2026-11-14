import type { PrismaService } from '../prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';

/**
 * May `principal` see this person at all — their face, their profile?
 *
 * Yourself, a platform admin, or somebody you actually share a workspace with.
 * "Any authenticated caller" would let one tenant enumerate another's people by
 * id (#1091). One indexed query rather than an AclGuard source because there is
 * no single workspace to resolve: a user belongs to several, and the answer is
 * whether *any* of them overlaps.
 */
export async function canSeeUser(prisma: PrismaService, principal: Principal, userId: string): Promise<boolean> {
  if (principal.mode === 'dev' || principal.isAdmin || principal.userId === userId) return true;
  const shared = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { members: { some: { userId: principal.userId } } } },
    select: { workspaceId: true },
  });
  return shared !== null;
}

/** The subject or a platform admin: who may read an account's flags (admin, password, API key). */
export function seesAccountFlags(principal: Principal, userId: string): boolean {
  return principal.mode === 'dev' || principal.isAdmin || principal.userId === userId;
}
