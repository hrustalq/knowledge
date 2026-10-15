import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type AccessRequest } from '@prisma/client';
import {
  accessRank,
  type AccessLevel,
  type AccessRequestEntry,
  type AccessRequestPerson,
  type AccessRequestStatus,
  type AccessResourceType,
  type ListAccessRequestsResponse,
  type RequestableAccessLevel,
  type WorkspaceRole,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { t } from '../i18n/t.js';
import { levelOn, type AccessIdentity, type ChainNode, type GrantRow } from './access-scope.js';
import type { AccessResource, ResolvedChain } from './acl-read.js';
import { PermissionService } from './permission.service.js';
import { AclEventsService, resourceTarget } from './acl-events.service.js';

/** Newest first, and no more than a manager's inbox shows. */
const LIST_LIMIT = 100;
/** Requests expired per sweep; the next tick takes the rest. */
const EXPIRE_BATCH = 100;

/**
 * Asking for a page (#76, phase 5): request → the node's managers hear →
 * approve with a level, or deny → the requester hears. A pending request
 * lapses after ACCESS_REQUEST_TTL_DAYS.
 *
 * What approving grants, and where, is `grantTargets`: intersective
 * restrictions mean a page under a restricted parent opens only once the
 * parent does, so a grant on the page alone would admit no one. The approver
 * must manage every node it writes to.
 *
 * In `PermissionsCoreModule`, not beside the controller, because MCP's
 * `knowledge_request_access` asks through it too.
 */
@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly aclEvents: AclEventsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async create(
    principal: Principal,
    dto: {
      workspaceId: string;
      resourceType: AccessResourceType;
      resourceId: string;
      level: RequestableAccessLevel;
      message?: string | null;
    },
  ): Promise<AccessRequestEntry> {
    const resource: AccessResource = { type: dto.resourceType, id: dto.resourceId };
    const resolved = await this.chainIn(dto.workspaceId, resource);
    const scope = await this.permissions.scopeFor(principal, dto.workspaceId);
    const level = levelOn(scope, resolved.chain, resolved.grants);
    // A guest is answered 404 for a page they cannot open (the guard's rule):
    // a request must not be how they learn that it exists.
    if (scope.guest && level === 'none') throw notFound(resource);
    if (accessRank(level) >= accessRank(dto.level)) {
      throw new ConflictException({ statusCode: 409, message: t('error.access.alreadyGranted'), reason: 'access.alreadyGranted' });
    }
    if (dto.level === 'edit' && !canHoldEdit(scope.role)) {
      throw new ConflictException({ statusCode: 409, message: t('error.access.levelAboveRole'), reason: 'access.levelAboveRole' });
    }

    let row: AccessRequest;
    try {
      row = await this.prisma.accessRequest.create({
        data: {
          workspaceId: dto.workspaceId,
          resourceType: resource.type,
          resourceId: resource.id,
          requesterId: principal.userId,
          level: dto.level,
          message: dto.message?.trim() || null,
        },
      });
    } catch (e) {
      // `access_requests_one_pending`: one pending request per person and node.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({ statusCode: 409, message: t('error.access.requestDuplicate'), reason: 'access.requestDuplicate' });
      }
      throw e;
    }

    const self = resolved.chain[resolved.chain.length - 1];
    const managers = await this.managersOf(dto.workspaceId, resolved, principal.userId);
    await this.aclEvents.notify({
      workspaceId: dto.workspaceId,
      userIds: managers,
      type: 'access.requested',
      reason: 'manager',
      actor: principal.userId,
      ...resourceTarget(resource),
      title: self.title,
      metadata: { requestId: row.id, resourceType: resource.type, resourceId: resource.id, level: dto.level },
    });
    void this.audit.record({
      workspaceId: dto.workspaceId,
      actor: principal.userId,
      action: 'acl.request',
      params: { requestId: row.id, resourceType: resource.type, resourceId: resource.id, level: dto.level },
      ok: true,
    });
    return (await this.describe(principal, dto.workspaceId, [row]))[0];
  }

  /**
   * `mine`: the caller's own requests. Otherwise the requests the caller may
   * decide — every one for a workspace admin. A guest only ever sees their own.
   */
  async list(
    principal: Principal,
    workspaceId: string,
    filter: { status?: AccessRequestStatus; mine?: boolean; resourceType?: AccessResourceType; resourceId?: string },
  ): Promise<ListAccessRequestsResponse> {
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const mine = filter.mine || scope.guest;
    const rows = await this.prisma.accessRequest.findMany({
      where: {
        workspaceId,
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.resourceType ? { resourceType: filter.resourceType } : {}),
        ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
        ...(mine ? { requesterId: principal.userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    const entries = await this.describe(principal, workspaceId, rows);
    return { workspaceId, requests: mine ? entries : entries.filter((e) => e.canDecide) };
  }

  async approve(principal: Principal, requestId: string, decided?: AccessLevel): Promise<AccessRequestEntry> {
    const request = await this.pending(requestId);
    const resource: AccessResource = { type: request.resourceType as AccessResourceType, id: request.resourceId };
    const resolved = await this.permissions.resolveChain(resource);
    const requester = await this.identityOf(request.workspaceId, request.requesterId);
    if (!requester) {
      throw new BadRequestException(t('error.access.unknownSubjects', { subjects: request.requesterId }));
    }
    const level = decided ?? (request.level as AccessLevel);
    if (level !== 'view' && !canHoldEdit(requester.role)) {
      throw new ConflictException({ statusCode: 409, message: t('error.access.levelAboveRole'), reason: 'access.levelAboveRole' });
    }
    const targets = grantTargets(resolved.chain, resolved.grants, requester);
    const scope = await this.permissions.scopeFor(principal, request.workspaceId);
    for (const target of targets) {
      await this.permissions.requireLevel(scope, target, 'manage');
    }

    await this.prisma.withTransaction(async () => {
      const claimed = await this.prisma.accessRequest.updateMany({
        where: { id: requestId, status: 'pending' },
        data: { status: 'approved', decidedBy: principal.userId, decidedLevel: level, decidedAt: new Date() },
      });
      if (claimed.count === 0) throw notPending();
      for (const target of targets) {
        const existing = await this.prisma.accessGrant.findUnique({
          where: {
            resourceType_resourceId_subjectType_subjectId_origin: {
              resourceType: target.type,
              resourceId: target.id,
              subjectType: 'user',
              subjectId: request.requesterId,
              origin: 'manual',
            },
          },
        });
        if (!existing) {
          await this.prisma.accessGrant.create({
            data: {
              workspaceId: request.workspaceId,
              resourceType: target.type,
              resourceId: target.id,
              subjectType: 'user',
              subjectId: request.requesterId,
              level,
              createdBy: principal.userId,
            },
          });
        } else if (accessRank(existing.level as AccessLevel) < accessRank(level)) {
          // Never lowers: approving view for someone who already edits is a no-op.
          await this.prisma.accessGrant.update({ where: { id: existing.id }, data: { level } });
        }
      }
    });

    await this.aclEvents.changed(request.workspaceId, principal.userId);
    await this.aclEvents.notify({
      workspaceId: request.workspaceId,
      userIds: [request.requesterId],
      type: 'access.approved',
      reason: 'participant',
      actor: principal.userId,
      ...resourceTarget(resource),
      title: resolved.chain[resolved.chain.length - 1].title,
      metadata: { requestId, resourceType: resource.type, resourceId: resource.id, level },
      requireAccess: false,
    });
    void this.audit.record({
      workspaceId: request.workspaceId,
      actor: principal.userId,
      action: 'acl.request.approve',
      params: { requestId, level, grantedOn: targets.map((n) => n.id) },
      ok: true,
    });
    return this.entry(principal, requestId);
  }

  async deny(principal: Principal, requestId: string, reason?: string | null): Promise<AccessRequestEntry> {
    const request = await this.pending(requestId);
    const resource: AccessResource = { type: request.resourceType as AccessResourceType, id: request.resourceId };
    const resolved = await this.permissions.resolveChain(resource);
    const requester = (await this.identityOf(request.workspaceId, request.requesterId)) ?? strangerIdentity(request.requesterId);
    const scope = await this.permissions.scopeFor(principal, request.workspaceId);
    for (const target of grantTargets(resolved.chain, resolved.grants, requester)) {
      await this.permissions.requireLevel(scope, target, 'manage');
    }
    const claimed = await this.prisma.accessRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: 'denied', decidedBy: principal.userId, decidedAt: new Date(), reason: reason?.trim() || null },
    });
    if (claimed.count === 0) throw notPending();
    await this.tellRequester(request, 'access.denied', principal.userId, { reason: reason?.trim() || null });
    void this.audit.record({
      workspaceId: request.workspaceId,
      actor: principal.userId,
      action: 'acl.request.deny',
      params: { requestId },
      ok: true,
    });
    return this.entry(principal, requestId);
  }

  /** Withdraw one's own pending request. */
  async cancel(principal: Principal, requestId: string): Promise<AccessRequestEntry> {
    const request = await this.pending(requestId);
    if (request.requesterId !== principal.userId) {
      throw new ConflictException({ statusCode: 409, message: t('error.access.requestOwnOnly'), reason: 'access.requestOwnOnly' });
    }
    const claimed = await this.prisma.accessRequest.updateMany({
      where: { id: requestId, status: 'pending' },
      data: { status: 'cancelled', decidedAt: new Date() },
    });
    if (claimed.count === 0) throw notPending();
    return this.entry(principal, requestId);
  }

  /**
   * Lapse requests older than the TTL, telling each requester. One guarded
   * update per row, so a request a manager decided a moment ago stays decided
   * and its requester is not told it expired.
   */
  async expireDue(now = new Date()): Promise<number> {
    const days = this.config.get('ACCESS_REQUEST_TTL_DAYS', { infer: true });
    const due = await this.prisma.accessRequest.findMany({
      where: { status: 'pending', createdAt: { lt: new Date(now.getTime() - days * 86_400_000) } },
      orderBy: { createdAt: 'asc' },
      take: EXPIRE_BATCH,
    });
    let expired = 0;
    for (const request of due) {
      const claimed = await this.prisma.accessRequest.updateMany({
        where: { id: request.id, status: 'pending' },
        data: { status: 'expired', decidedAt: now },
      });
      if (claimed.count === 0) continue;
      expired += 1;
      await this.tellRequester(request, 'access.expired', null, {});
    }
    return expired;
  }

  // ------------------------------------------------------------ helpers

  /**
   * The requester, told about a request they may still be unable to open: no
   * title, so the answer is not how they learn what the page is called.
   */
  private async tellRequester(
    request: AccessRequest,
    type: 'access.denied' | 'access.expired',
    actor: string | null,
    extra: Record<string, unknown>,
  ): Promise<void> {
    await this.aclEvents.notify({
      workspaceId: request.workspaceId,
      userIds: [request.requesterId],
      type,
      reason: 'participant',
      actor,
      ...resourceTarget({ type: request.resourceType as AccessResourceType, id: request.resourceId }),
      title: null,
      metadata: { requestId: request.id, resourceType: request.resourceType, resourceId: request.resourceId, level: request.level, ...extra },
      requireAccess: false,
    });
  }

  /** The chain, refusing a node that is not in the workspace the request names. */
  private async chainIn(workspaceId: string, resource: AccessResource): Promise<ResolvedChain> {
    const resolved = await this.permissions.resolveChain(resource);
    if (resolved.workspaceId !== workspaceId) throw notFound(resource);
    return resolved;
  }

  private async pending(requestId: string): Promise<AccessRequest> {
    const request = await this.prisma.accessRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException(t('error.access.requestNotFound', { id: requestId }));
    if (request.status !== 'pending') throw notPending();
    return request;
  }

  /** A member's identity for `levelOn`, or null for someone who has left the workspace. */
  private async identityOf(workspaceId: string, userId: string): Promise<AccessIdentity | null> {
    const [member, groups] = await Promise.all([
      this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true, user: { select: { isAdmin: true } } },
      }),
      this.prisma.userGroupMember.findMany({ where: { userId, group: { workspaceId } }, select: { groupId: true } }),
    ]);
    if (!member) return null;
    const role = member.role as WorkspaceRole;
    return {
      userId,
      role,
      bypass: role === 'admin' || member.user.isAdmin,
      guest: role === 'guest',
      readOnly: false,
      groupIds: new Set(groups.map((g) => g.groupId)),
    };
  }

  /**
   * Who hears about a request: whoever holds a manage grant on the chain
   * (directly or through a group), plus the workspace admins. Not every editor
   * who could approve it — on a page nobody named managers for, that is the
   * whole team; they still find it under Access → Requests.
   */
  private async managersOf(workspaceId: string, resolved: ResolvedChain, requesterId: string): Promise<string[]> {
    const manageGrants = resolved.grants.filter((g) => g.level === 'manage');
    const groupIds = manageGrants.filter((g) => g.subjectType === 'group').map((g) => g.subjectId);
    const [admins, groupMembers] = await Promise.all([
      this.prisma.workspaceMember.findMany({ where: { workspaceId, role: 'admin' }, select: { userId: true } }),
      groupIds.length
        ? this.prisma.userGroupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })
        : [],
    ]);
    const ids = new Set([
      ...admins.map((a) => a.userId),
      ...groupMembers.map((m) => m.userId),
      ...manageGrants.filter((g) => g.subjectType === 'user').map((g) => g.subjectId),
    ]);
    ids.delete(requesterId);
    return [...ids];
  }

  private async entry(principal: Principal, requestId: string): Promise<AccessRequestEntry> {
    const row = await this.prisma.accessRequest.findUniqueOrThrow({ where: { id: requestId } });
    return (await this.describe(principal, row.workspaceId, [row]))[0];
  }

  /**
   * Rows as the caller may read them: the node's name only when the caller can
   * open it, and `canDecide` when they manage every node approving would write.
   * One chain read per distinct node.
   */
  private async describe(principal: Principal, workspaceId: string, rows: AccessRequest[]): Promise<AccessRequestEntry[]> {
    if (rows.length === 0) return [];
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const ttlMs = this.config.get('ACCESS_REQUEST_TTL_DAYS', { infer: true }) * 86_400_000;

    const chains = new Map<string, ResolvedChain | null>();
    for (const row of rows) {
      if (chains.has(row.resourceId)) continue;
      chains.set(
        row.resourceId,
        await this.permissions
          .resolveChain({ type: row.resourceType as AccessResourceType, id: row.resourceId })
          .catch(() => null), // the node was deleted; the request still lists, nameless
      );
    }
    const peopleIds = [...new Set(rows.flatMap((r) => [r.requesterId, ...(r.decidedBy ? [r.decidedBy] : [])]))];
    const users = await this.prisma.user.findMany({ where: { id: { in: peopleIds } } });
    const userById = new Map(users.map((u) => [u.id, u]));
    const person = (id: string): AccessRequestPerson => {
      const u = userById.get(id);
      return { userId: id, displayName: u?.displayName ?? null, email: u?.email ?? null, avatarUrl: u ? userAvatarUrl(u) : null };
    };
    const identities = new Map<string, AccessIdentity>();

    const out: AccessRequestEntry[] = [];
    for (const row of rows) {
      const resolved = chains.get(row.resourceId) ?? null;
      let canDecide = false;
      let title: string | null = null;
      if (resolved) {
        if (levelOn(scope, resolved.chain, resolved.grants) !== 'none') title = resolved.chain[resolved.chain.length - 1].title;
        if (row.status === 'pending' && row.requesterId !== principal.userId) {
          if (!identities.has(row.requesterId)) {
            identities.set(
              row.requesterId,
              (await this.identityOf(workspaceId, row.requesterId)) ?? strangerIdentity(row.requesterId),
            );
          }
          const targets = grantTargets(resolved.chain, resolved.grants, identities.get(row.requesterId)!);
          canDecide = targets.every((target) => {
            const upTo = resolved.chain.slice(0, resolved.chain.findIndex((n) => n.id === target.id) + 1);
            return levelOn(scope, upTo, resolved.grants) === 'manage';
          });
        }
      }
      out.push({
        requestId: row.id,
        workspaceId: row.workspaceId,
        resourceType: row.resourceType as AccessResourceType,
        resourceId: row.resourceId,
        resourceTitle: title,
        requester: person(row.requesterId),
        level: row.level as RequestableAccessLevel,
        message: row.message,
        status: row.status as AccessRequestStatus,
        decidedBy: row.decidedBy ? person(row.decidedBy) : null,
        decidedLevel: (row.decidedLevel as AccessLevel | null) ?? null,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        reason: row.reason,
        expiresAt: new Date(row.createdAt.getTime() + ttlMs).toISOString(),
        createdAt: row.createdAt.toISOString(),
        canDecide,
      });
    }
    return out;
  }
}

/**
 * The nodes approving a request writes a grant on (#76, phase 5).
 *
 * Every restricted node on the chain the requester holds no grant on: view is
 * intersective, so each one has to admit them, and a grant below a closed
 * ancestor admits no one. When they already pass every restriction (asking to
 * edit what they can read), the nearest restricted node, which is where the
 * edit gate sits. On a chain with nothing restricted, the node itself — which
 * is how a guest is let in, or handed edit.
 */
export function grantTargets(chain: ChainNode[], grants: GrantRow[], who: AccessIdentity): ChainNode[] {
  const holds = (nodeId: string) =>
    grants.some(
      (g) =>
        g.resourceId === nodeId &&
        ((g.subjectType === 'user' && g.subjectId === who.userId) ||
          (g.subjectType === 'group' && who.groupIds.has(g.subjectId))),
    );
  const restricted = chain.filter((n) => n.restricted);
  const missing = restricted.filter((n) => !holds(n.id));
  if (missing.length > 0) return missing;
  if (restricted.length > 0) return [restricted[restricted.length - 1]];
  return [chain[chain.length - 1]];
}

/** Edit can be held by an editor or admin, and by a guest granted it explicitly — never by a viewer. */
function canHoldEdit(role: WorkspaceRole | null): boolean {
  return role === null || role === 'editor' || role === 'admin' || role === 'guest';
}

/** A requester who has left the workspace, for deciding what denying would have touched. */
function strangerIdentity(userId: string): AccessIdentity {
  return { userId, role: null, bypass: false, guest: true, readOnly: false, groupIds: new Set() };
}

function notFound(resource: AccessResource): NotFoundException {
  return new NotFoundException(
    t(resource.type === 'project' ? 'error.project.notFound' : 'error.document.notFound', { id: resource.id }),
  );
}

function notPending(): ConflictException {
  return new ConflictException({ statusCode: 409, message: t('error.access.requestNotPending'), reason: 'access.requestNotPending' });
}
