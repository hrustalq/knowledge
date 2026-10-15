import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type {
  AccessGrantEntry,
  AccessGrantInput,
  AccessLevel,
  AccessSubjectType,
  EffectiveAccessEntry,
  EffectiveAccessResponse,
  ResourceAccessResponse,
  WorkspaceRole,
} from '@knowledge/contracts';
import { accessRank } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { t } from '../i18n/t.js';
import { levelOn } from './access-scope.js';
import { PermissionService, type AccessResource } from './permission.service.js';
import { AclEventsService } from './acl-events.service.js';

/**
 * Reading and changing one node's restriction (#76): the switch, its grants,
 * and who that lets in.
 *
 * Routes reach this through `@Access('viewer', 'document' | 'project')`, so
 * the caller can already open the node; changing it or listing who can see it
 * additionally needs `manage` on it, checked here.
 */
@Injectable()
export class ResourceAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly aclEvents: AclEventsService,
  ) {}

  async get(principal: Principal, resource: AccessResource): Promise<ResourceAccessResponse> {
    const { workspaceId, chain, grants } = await this.permissions.resolveChain(resource);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const level = levelOn(scope, chain, grants);
    const self = chain[chain.length - 1];
    const canManage = level === 'manage';
    const own = grants.filter((g) => g.resourceId === self.id);
    return {
      resourceType: resource.type,
      resourceId: resource.id,
      restricted: self.restricted,
      inherited: chain.slice(0, -1).flatMap((node, i) =>
        node.restricted
          ? [
              {
                resourceType: node.type,
                resourceId: node.id,
                // A guest reaches a page without reaching what is above it; the
                // name of a node they cannot open is not theirs to read.
                title: !scope.guest || chain.slice(0, i + 1).some((n) => scope.granted.has(n.id)) ? node.title : null,
                grantCount: grants.filter((g) => g.resourceId === node.id).length,
              },
            ]
          : [],
      ),
      level,
      canManage,
      grants: canManage
        ? await this.describe(
            workspaceId,
            own.map((g) => ({
              subjectType: g.subjectType as AccessSubjectType,
              subjectId: g.subjectId,
              level: g.level as AccessLevel,
            })),
          )
        : [],
    };
  }

  /**
   * Replace the node's switch and manual grants in one transaction, then
   * rewrite `restricted_by` below it if the switch moved.
   *
   * Refused with 409 `access.selfLockout` when the result would leave a
   * non-admin caller without `manage` here: restricting a page to a group you
   * are not in is how a page ends up managed by nobody but the admins.
   */
  async update(
    principal: Principal,
    resource: AccessResource,
    dto: { restricted: boolean; grants: AccessGrantInput[] },
  ): Promise<ResourceAccessResponse> {
    const { workspaceId, chain, grants } = await this.permissions.resolveChain(resource);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    if (levelOn(scope, chain, grants) !== 'manage') {
      await this.permissions.requireLevel(scope, resource, 'manage'); // throws the guard's 403
    }

    const wanted = dedupe(dto.grants);
    await this.assertSubjects(workspaceId, wanted);

    const self = chain[chain.length - 1];
    const nextChain = [...chain.slice(0, -1), { ...self, restricted: dto.restricted }];
    const nextGrants = [
      ...grants.filter((g) => g.resourceId !== self.id),
      ...wanted.map((g) => ({ resourceId: self.id, ...g })),
    ];
    if (levelOn(scope, nextChain, nextGrants) !== 'manage') {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.access.selfLockout'),
        reason: 'access.selfLockout',
      });
    }

    await this.prisma.withTransaction(async () => {
      if (resource.type === 'project') {
        await this.prisma.project.update({ where: { id: resource.id }, data: { restricted: dto.restricted } });
      } else {
        await this.prisma.document.update({ where: { id: resource.id }, data: { restricted: dto.restricted } });
      }
      // Manual grants only: rows a connector mirrored are its own to rewrite.
      await this.prisma.accessGrant.deleteMany({
        where: { resourceType: resource.type, resourceId: resource.id, origin: 'manual' },
      });
      await this.prisma.accessGrant.createMany({
        data: wanted.map((g) => ({
          workspaceId,
          resourceType: resource.type,
          resourceId: resource.id,
          subjectType: g.subjectType,
          subjectId: g.subjectId,
          level: g.level,
          createdBy: principal.userId,
        })),
        skipDuplicates: true,
      });
      if (dto.restricted !== self.restricted) {
        await this.permissions.recomputeRestrictedBy(
          resource.type === 'project' ? { projectId: resource.id } : { documentId: resource.id },
        );
      }
    });

    await this.aclEvents.changed(workspaceId, principal.userId);
    // People named here for the first time hear about it. Groups do not: a
    // group grant is a decision about a team, not a message to each member.
    const before = new Set(grants.filter((g) => g.resourceId === self.id && g.subjectType === 'user').map((g) => g.subjectId));
    for (const level of ['view', 'edit', 'manage'] as const) {
      await this.aclEvents.granted({
        workspaceId,
        resource,
        title: self.title,
        userIds: wanted
          .filter((g) => g.subjectType === 'user' && g.level === level && !before.has(g.subjectId) && g.subjectId !== principal.userId)
          .map((g) => g.subjectId),
        actor: principal.userId,
        level,
      });
    }

    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'acl.update',
      params: { resourceType: resource.type, resourceId: resource.id, restricted: dto.restricted, grants: wanted },
      ok: true,
    });
    return this.get(principal, resource);
  }

  /**
   * "Who can see this": every workspace member with the level the same
   * `levelOn` gives them, highest first. A manager's view — it names who is
   * in the groups a page is restricted to.
   */
  async effective(principal: Principal, resource: AccessResource): Promise<EffectiveAccessResponse> {
    const { workspaceId, chain, grants } = await this.permissions.resolveChain(resource);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    if (levelOn(scope, chain, grants) !== 'manage') {
      await this.permissions.requireLevel(scope, resource, 'manage');
    }
    const [members, memberships] = await Promise.all([
      this.prisma.workspaceMember.findMany({ where: { workspaceId }, include: { user: true } }),
      this.prisma.userGroupMember.findMany({ where: { group: { workspaceId } }, select: { groupId: true, userId: true } }),
    ]);
    const groupsOf = new Map<string, Set<string>>();
    for (const m of memberships) {
      if (!groupsOf.has(m.userId)) groupsOf.set(m.userId, new Set());
      groupsOf.get(m.userId)!.add(m.groupId);
    }
    const restricted = chain.some((n) => n.restricted);
    const entries: EffectiveAccessEntry[] = [];
    for (const m of members) {
      const role = m.role as WorkspaceRole;
      const bypass = role === 'admin' || m.user.isAdmin;
      const guest = role === 'guest';
      const level = levelOn(
        { userId: m.userId, role, bypass, guest, readOnly: false, groupIds: groupsOf.get(m.userId) ?? new Set() },
        chain,
        grants,
      );
      if (level === 'none') continue;
      entries.push({
        userId: m.userId,
        displayName: m.user.displayName,
        email: m.user.email,
        avatarUrl: userAvatarUrl(m.user),
        role,
        level,
        source: bypass ? 'admin' : guest || restricted ? 'grant' : 'role',
      });
    }
    entries.sort((a, b) => accessRank(b.level) - accessRank(a.level) || a.displayName.localeCompare(b.displayName));
    return { resourceType: resource.type, resourceId: resource.id, entries };
  }

  /** Grants to people must name members (guests included); grants to groups, this workspace's groups. */
  private async assertSubjects(workspaceId: string, grants: AccessGrantInput[]): Promise<void> {
    const userIds = grants.filter((g) => g.subjectType === 'user').map((g) => g.subjectId);
    const groupIds = grants.filter((g) => g.subjectType === 'group').map((g) => g.subjectId);
    const [users, groups] = await Promise.all([
      userIds.length
        ? this.prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: userIds } }, select: { userId: true } })
        : [],
      groupIds.length
        ? this.prisma.userGroup.findMany({ where: { workspaceId, id: { in: groupIds } }, select: { id: true } })
        : [],
    ]);
    const known = new Set([...users.map((u) => u.userId), ...groups.map((g) => g.id)]);
    const unknown = grants.filter((g) => !known.has(g.subjectId)).map((g) => g.subjectId);
    if (unknown.length > 0) {
      throw new BadRequestException(t('error.access.unknownSubjects', { subjects: unknown.join(', ') }));
    }
  }

  /** Names and faces for a grant list. A subject that no longer resolves keeps its row with a null name. */
  private async describe(workspaceId: string, grants: AccessGrantInput[]): Promise<AccessGrantEntry[]> {
    const userIds = grants.filter((g) => g.subjectType === 'user').map((g) => g.subjectId);
    const groupIds = grants.filter((g) => g.subjectType === 'group').map((g) => g.subjectId);
    const [users, groups] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } } }) : [],
      groupIds.length
        ? this.prisma.userGroup.findMany({
            where: { workspaceId, id: { in: groupIds } },
            include: { _count: { select: { members: true } } },
          })
        : [],
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const groupById = new Map(groups.map((g) => [g.id, g]));
    return grants
      .map((g): AccessGrantEntry => {
        if (g.subjectType === 'user') {
          const u = userById.get(g.subjectId);
          return { ...g, name: u?.displayName ?? null, email: u?.email ?? null, avatarUrl: u ? userAvatarUrl(u) : null, memberCount: null };
        }
        const group = groupById.get(g.subjectId);
        return { ...g, name: group?.name ?? null, email: null, avatarUrl: null, memberCount: group?._count.members ?? null };
      })
      .sort(
        (a, b) =>
          a.subjectType.localeCompare(b.subjectType) ||
          accessRank(b.level) - accessRank(a.level) ||
          (a.name ?? '').localeCompare(b.name ?? ''),
      );
  }
}

/** One grant per subject; the last one named wins, as a form submitting a list would expect. */
function dedupe(grants: AccessGrantInput[]): AccessGrantInput[] {
  const bySubject = new Map<string, AccessGrantInput>();
  for (const g of grants) bySubject.set(`${g.subjectType}:${g.subjectId}`, g);
  return [...bySubject.values()];
}
