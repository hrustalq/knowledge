import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The membership writes that must never leave a workspace without an admin,
 * shared by the members routes and IdP role sync (#75).
 *
 * Last-admin protection has to be ONE statement. `count(other admins)` then
 * `update`/`delete` is check-then-act with nothing enforcing it: two concurrent
 * removals of the last two admins each counted one other admin and each
 * proceeded, leaving a workspace with zero admins — which no API route can
 * repair, since adding a member is itself admin-gated. The EXISTS subquery is
 * evaluated inside the same statement as the write, so exactly one wins. Raw
 * SQL for the same reason AgentFindingsService.claim uses it: the query API
 * cannot express a predicate over a sibling row set.
 *
 * Both return false when the guard refused (or the row is gone, or is
 * outside `sources`); the caller decides whether that is a 400 or
 * an audited skip.
 */

export interface GuardOptions {
  /**
   * Touch the row only while its `source` is one of these (role sync and SCIM,
   * #75), so neither ever writes a `manual` row or the other's. In the
   * statement rather than read beforehand, so an admin taking the row over
   * mid-sign-in wins. Absent: any row.
   */
  sources?: readonly string[];
}

/** Set a member's role, refused only when it would demote the last admin. */
export async function setRoleGuarded(
  prisma: PrismaService,
  workspaceId: string,
  userId: string,
  role: string,
  opts: GuardOptions = {},
): Promise<boolean> {
  const sources = opts.sources ? [...opts.sources] : null;
  const affected = await prisma.$executeRaw`
    UPDATE workspace_members
       SET role = ${role}
     WHERE workspace_id = ${workspaceId}::uuid
       AND user_id = ${userId}::uuid
       AND (${sources}::text[] IS NULL OR source = ANY(${sources}::text[]))
       AND (role <> 'admin' OR ${role}::text = 'admin' OR EXISTS (
             SELECT 1 FROM workspace_members other
              WHERE other.workspace_id = ${workspaceId}::uuid
                AND other.role = 'admin'
                AND other.user_id <> ${userId}::uuid
           ))
  `;
  return affected > 0;
}

/**
 * Remove a member, refused only when they are the last admin. Leaving also
 * drops their groups and page grants (see {@link dropWorkspaceAccess}).
 */
export async function removeMemberGuarded(
  prisma: PrismaService,
  workspaceId: string,
  userId: string,
  opts: GuardOptions = {},
): Promise<boolean> {
  const sources = opts.sources ? [...opts.sources] : null;
  const affected = await prisma.$executeRaw`
    DELETE FROM workspace_members
     WHERE workspace_id = ${workspaceId}::uuid
       AND user_id = ${userId}::uuid
       AND (${sources}::text[] IS NULL OR source = ANY(${sources}::text[]))
       AND (role <> 'admin' OR EXISTS (
             SELECT 1 FROM workspace_members other
              WHERE other.workspace_id = ${workspaceId}::uuid
                AND other.role = 'admin'
                AND other.user_id <> ${userId}::uuid
           ))
  `;
  if (affected === 0) return false;
  await dropWorkspaceAccess(prisma, workspaceId, userId);
  return true;
}

/**
 * Leaving the workspace means leaving its groups and losing its page grants
 * (#76). Kept, the rows would silently hand back everything those groups and
 * grants held the day the person is re-added — access nobody granted.
 */
export async function dropWorkspaceAccess(prisma: PrismaService, workspaceId: string, userId: string): Promise<void> {
  // withTransaction, not $transaction: SCIM offboarding reaches this from inside its own boundary (#656).
  await prisma.withTransaction(async () => {
    await prisma.userGroupMember.deleteMany({ where: { userId, group: { workspaceId } } });
    await prisma.accessGrant.deleteMany({ where: { workspaceId, subjectType: 'user', subjectId: userId } });
  });
}
