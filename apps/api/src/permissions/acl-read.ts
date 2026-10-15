import { NotFoundException } from '@nestjs/common';
import type { AccessResourceType, WorkspaceRole } from '@knowledge/contracts';
import type { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { levelOn, type ChainNode, type GrantRow } from './access-scope.js';

export interface AccessResource {
  type: AccessResourceType;
  id: string;
}

/** A resource's chain with what the access routes show about each node. */
export interface ResolvedChain {
  workspaceId: string;
  /** Outermost first: the project, then ancestors root-first, then the resource itself. */
  chain: (ChainNode & { title: string })[];
  /** Every grant on every node of the chain, whoever holds it. */
  grants: GrantRow[];
}

type AclDb = Pick<PrismaService, 'project' | 'document' | 'accessGrant' | 'workspaceMember' | 'userGroupMember'>;

/*
 * The two page-permission reads that need nothing but the database, as plain
 * functions (#76, phase 5).
 *
 * `PermissionService` delegates to them, and so does `NotificationsService`,
 * which may not inject `PermissionService`: `EventsModule` imports the
 * notifications module, and the permission module publishes `acl.changed`
 * through `EventsModule` — a provider either way round would close a cycle.
 * A leaf both sides import is the house way out of one.
 */

/**
 * A resource's chain, project first, with every grant on it. Ancestors that
 * no longer exist (no FK on parent_id) simply drop out of the chain.
 */
export async function resolveChain(db: AclDb, resource: AccessResource): Promise<ResolvedChain> {
  let workspaceId: string;
  let chain: ResolvedChain['chain'];
  if (resource.type === 'project') {
    const project = await db.project.findUnique({
      where: { id: resource.id },
      select: { workspaceId: true, name: true, restricted: true },
    });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: resource.id }));
    workspaceId = project.workspaceId;
    chain = [{ type: 'project', id: resource.id, restricted: project.restricted, title: project.name }];
  } else {
    const doc = await db.document.findUnique({
      where: { id: resource.id },
      select: { workspaceId: true, projectId: true, path: true },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: resource.id }));
    workspaceId = doc.workspaceId;
    const pathIds = doc.path.split('/').filter(Boolean);
    if (!pathIds.includes(resource.id)) pathIds.push(resource.id); // a `/pending/` row: itself alone
    const [project, nodes] = await Promise.all([
      db.project.findUnique({ where: { id: doc.projectId }, select: { name: true, restricted: true } }),
      db.document.findMany({
        where: { workspaceId, id: { in: pathIds.filter((id) => UUID_RE.test(id)) } },
        select: { id: true, title: true, restricted: true },
      }),
    ]);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    chain = [
      { type: 'project', id: doc.projectId, restricted: project?.restricted ?? false, title: project?.name ?? '' },
      ...pathIds.flatMap((id) => {
        const n = byId.get(id);
        return n ? [{ type: 'document' as const, id, restricted: n.restricted, title: n.title }] : [];
      }),
    ];
  }
  const grants = await db.accessGrant.findMany({
    where: { resourceId: { in: chain.map((n) => n.id) } },
    select: { resourceId: true, subjectType: true, subjectId: true, level: true },
  });
  return { workspaceId, chain, grants };
}

/**
 * Which of `userIds` may open the resource — for handing someone work on a
 * page (a review, an assignment) or telling them about it. Non-members and
 * anyone the chain keeps out drop out; workspace and platform admins stay.
 */
export async function whoCanOpen(db: AclDb, resource: AccessResource, userIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Set();
  const { workspaceId, chain, grants } = await resolveChain(db, resource);
  const [members, memberships] = await Promise.all([
    db.workspaceMember.findMany({
      where: { workspaceId, userId: { in: unique } },
      select: { userId: true, role: true, user: { select: { isAdmin: true } } },
    }),
    db.userGroupMember.findMany({
      where: { userId: { in: unique }, group: { workspaceId } },
      select: { userId: true, groupId: true },
    }),
  ]);
  const out = new Set<string>();
  for (const m of members) {
    const role = m.role as WorkspaceRole;
    const groupIds = new Set(memberships.filter((g) => g.userId === m.userId).map((g) => g.groupId));
    const who = { userId: m.userId, role, bypass: role === 'admin' || m.user.isAdmin, guest: role === 'guest', readOnly: false, groupIds };
    if (levelOn(who, chain, grants) !== 'none') out.add(m.userId);
  }
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
