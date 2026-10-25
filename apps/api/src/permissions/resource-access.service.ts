import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  BranchAccessResponse,
  AccessGrantEntry,
  AccessGrantInput,
  AccessGrantOrigin,
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
    const draft =
      resource.type === 'document' &&
      !!(await this.prisma.document.findUnique({ where: { id: resource.id }, select: { draftOwnerId: true } }))?.draftOwnerId;
    // Read again for who wrote each row: a mirrored grant is shown, never sent back.
    const own = canManage
      ? await this.prisma.accessGrant.findMany({
          where: { resourceType: resource.type, resourceId: self.id },
          select: { subjectType: true, subjectId: true, level: true, origin: true, connectorId: true },
        })
      : [];
    return {
      resourceType: resource.type,
      resourceId: resource.id,
      restricted: self.restricted,
      draft,
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
              origin: g.origin as AccessGrantOrigin,
              connectorId: g.connectorId,
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

    // A private draft leaves its restriction one way, so its watchers and the
    // feed are told (#474): publish.
    if (resource.type === 'document' && !dto.restricted) {
      const doc = await this.prisma.document.findUnique({ where: { id: resource.id }, select: { draftOwnerId: true } });
      if (doc?.draftOwnerId) {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.access.draftPublishFirst'),
          reason: 'access.draftPublishFirst',
        });
      }
    }

    const wanted = dedupe(dto.grants);
    await this.assertSubjects(workspaceId, wanted);

    const self = chain[chain.length - 1];
    const nextChain = [...chain.slice(0, -1), { ...self, restricted: dto.restricted }];
    const nextGrants = [
      // A connector's rows on this node stay: the PUT replaces manual grants only.
      ...grants.filter((g) => g.resourceId !== self.id || (g.origin ?? 'manual') !== 'manual'),
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
    const before = new Set(
      grants.filter((g) => g.resourceId === self.id && g.subjectType === 'user').map((g) => g.subjectId),
    );
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
   * A private branch's share list (#474). The guard has already let the caller
   * read the branch; its grants are shown to who may change them — the owner
   * and admins — like a page's are to its managers.
   */
  async getBranch(principal: Principal, documentId: string, branchId: string): Promise<BranchAccessResponse> {
    const { branch, scope } = await this.branchFor(principal, documentId, branchId);
    const canManage = scope.bypass || branch.ownerId === scope.userId;
    const own = canManage
      ? await this.prisma.accessGrant.findMany({
          where: { resourceType: 'branch', resourceId: branchId },
          select: { subjectType: true, subjectId: true, level: true, origin: true, connectorId: true },
        })
      : [];
    return {
      branchId,
      restricted: branch.restricted,
      ownerId: branch.ownerId,
      canManage,
      grants: canManage
        ? await this.describe(
            scope.workspaceId,
            own.map((g) => ({
              subjectType: g.subjectType as AccessSubjectType,
              subjectId: g.subjectId,
              level: g.level as AccessLevel,
              origin: g.origin as AccessGrantOrigin,
              connectorId: g.connectorId,
            })),
          )
        : [],
    };
  }

  /**
   * Replace a private branch's grants (#474). Its owner or an admin only, at
   * `view` or `edit`: a branch has nothing to manage but this list, and that
   * stays with whoever started it.
   */
  async updateBranch(
    principal: Principal,
    documentId: string,
    branchId: string,
    dto: { grants: AccessGrantInput[] },
  ): Promise<BranchAccessResponse> {
    const { branch, scope, title } = await this.branchFor(principal, documentId, branchId);
    if (!scope.bypass && branch.ownerId !== scope.userId) {
      throw new ForbiddenException({ statusCode: 403, message: t('error.access.branchManageRequired'), resourceType: 'branch', resourceId: branchId });
    }
    const wanted = dedupe(dto.grants);
    if (wanted.some((g) => g.level === 'manage')) throw new BadRequestException(t('error.access.branchLevel'));
    await this.assertSubjects(scope.workspaceId, wanted);

    const before = await this.prisma.accessGrant.findMany({
      where: { resourceType: 'branch', resourceId: branchId, subjectType: 'user' },
      select: { subjectId: true },
    });
    await this.prisma.withTransaction(async () => {
      await this.prisma.accessGrant.deleteMany({ where: { resourceType: 'branch', resourceId: branchId, origin: 'manual' } });
      await this.prisma.accessGrant.createMany({
        data: wanted.map((g) => ({
          workspaceId: scope.workspaceId,
          resourceType: 'branch',
          resourceId: branchId,
          subjectType: g.subjectType,
          subjectId: g.subjectId,
          level: g.level,
          createdBy: principal.userId,
        })),
        skipDuplicates: true,
      });
    });

    await this.aclEvents.changed(scope.workspaceId, principal.userId);
    // Named for the first time: told, with a link to the page.
    const known = new Set(before.map((g) => g.subjectId));
    for (const level of ['view', 'edit'] as const) {
      const userIds = wanted
        .filter((g) => g.subjectType === 'user' && g.level === level && !known.has(g.subjectId) && g.subjectId !== principal.userId)
        .map((g) => g.subjectId);
      if (userIds.length === 0) continue;
      await this.aclEvents.notify({
        workspaceId: scope.workspaceId,
        userIds,
        type: 'access.granted',
        reason: 'participant',
        actor: principal.userId,
        documentId,
        subjectType: 'document',
        subjectId: documentId,
        title,
        metadata: { resourceType: 'branch', resourceId: branchId, branch: branch.name, level },
      });
    }
    void this.audit.record({
      workspaceId: scope.workspaceId,
      actor: principal.userId,
      action: 'acl.update',
      params: { resourceType: 'branch', resourceId: branchId, grants: wanted },
      ok: true,
    });
    return this.getBranch(principal, documentId, branchId);
  }

  private async branchFor(principal: Principal, documentId: string, branchId: string) {
    const branch = await this.prisma.documentBranch.findUnique({
      where: { id: branchId },
      select: { id: true, documentId: true, name: true, ownerId: true, restricted: true, document: { select: { title: true, workspaceId: true } } },
    });
    if (!branch || branch.documentId !== documentId) throw new NotFoundException(t('error.branch.hidden'));
    const scope = await this.permissions.scopeFor(principal, branch.document.workspaceId);
    return { branch, scope, title: branch.document.title };
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
  private async describe(
    workspaceId: string,
    grants: Array<AccessGrantInput & Pick<AccessGrantEntry, 'origin' | 'connectorId'>>,
  ): Promise<AccessGrantEntry[]> {
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
