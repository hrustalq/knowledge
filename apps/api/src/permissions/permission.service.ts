import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  accessRank,
  type AccessLevel,
  type AccessResourceType,
  type EffectiveAccessLevel,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import { AuditService } from '../auth/audit.service.js';
import { ROLE_ORDER, type Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import {
  levelOn,
  visibilityWhere,
  type AccessScope,
  type ChainNode,
  type GrantRow,
} from './access-scope.js';

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

/** One `acl.bypass` audit row per admin, resource and window — a page view is a dozen requests. */
const BYPASS_AUDIT_WINDOW_MS = 60_000;

/**
 * The page-permission predicate (#76), asked the same way by every process.
 *
 * `AccessService` stays the workspace gate. This adds what sits below it: which
 * pages a caller may open (`scopeFor` + `visibilityWhere`) and what they may do
 * with one (`levelFor`). It lives in `PermissionsCoreModule`, not beside the
 * controllers, because the worker and MCP have to ask exactly this question —
 * a second copy that drifted would be a leak.
 */
@Injectable()
export class PermissionService {
  private readonly bypassAudited = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The caller's visibility over one workspace. Three small reads: the
   * membership, their groups, and the restricted nodes against their grants.
   * A non-member who is not a platform admin is refused here exactly as
   * `requireRole` would refuse them.
   */
  async scopeFor(principal: Principal, workspaceId: string): Promise<AccessScope> {
    const readOnly = principal.apiKey?.scope === 'read';
    if (principal.mode === 'dev') {
      return {
        workspaceId,
        userId: principal.userId,
        role: null,
        bypass: true,
        guest: false,
        readOnly,
        groupIds: new Set(),
        denied: new Set(),
        granted: new Set(),
      };
    }
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: principal.userId } },
      select: { role: true },
    });
    if (!member && !principal.isAdmin) throw new ForbiddenException(t('error.auth.notMember', { workspaceId }));
    const role = (member?.role as WorkspaceRole | undefined) ?? null;

    const groups = await this.prisma.userGroupMember.findMany({
      where: { userId: principal.userId, group: { workspaceId } },
      select: { groupId: true },
    });
    const groupIds = groups.map((g) => g.groupId);
    const [grants, restrictedDocs, restrictedProjects] = await Promise.all([
      this.prisma.accessGrant.findMany({
        where: {
          workspaceId,
          OR: [
            { subjectType: 'user', subjectId: principal.userId },
            ...(groupIds.length ? [{ subjectType: 'group', subjectId: { in: groupIds } }] : []),
          ],
        },
        select: { resourceId: true },
      }),
      this.prisma.document.findMany({ where: { workspaceId, restricted: true }, select: { id: true } }),
      this.prisma.project.findMany({ where: { workspaceId, restricted: true }, select: { id: true } }),
    ]);
    const granted = new Set(grants.map((g) => g.resourceId));
    const denied = new Set([...restrictedProjects, ...restrictedDocs].map((n) => n.id).filter((id) => !granted.has(id)));
    return {
      workspaceId,
      userId: principal.userId,
      role,
      // Admins see everything, as before restrictions existed: they already
      // control who is in the workspace. Their reads of what they hold no
      // grant on are audited instead (`requireResource`).
      bypass: principal.isAdmin || role === 'admin',
      guest: role === 'guest',
      readOnly,
      groupIds: new Set(groupIds),
      denied,
      granted,
    };
  }

  /** `scopeFor` over the workspace a page lives in. */
  async scopeForDocument(principal: Principal, documentId: string): Promise<AccessScope> {
    return this.scopeFor(principal, await this.access.workspaceOfDocument(documentId));
  }

  /**
   * The guard's half for a route whose `:id` is a page, a merge request (its
   * page) or a project. The workspace role is checked as it always was —
   * except that a guest, who fails every workspace-level check, may reach a
   * resource granted to them on a viewer or editor route. Then the page level
   * must cover the route: viewer→view, editor→edit, admin→manage.
   *
   * A page the caller may not open is a 404 for a guest (they learn nothing,
   * not even that it exists) and a 403 carrying `canRequestAccess` for a
   * member — never its title.
   */
  async requireResource(
    principal: Principal,
    workspaceId: string,
    resource: AccessResource,
    role: WorkspaceRole,
    operator: boolean,
  ): Promise<void> {
    if (principal.apiKey) this.access.requireKeyAllows(principal.apiKey, workspaceId, role);
    if (principal.mode === 'dev') return;
    const scope = await this.scopeFor(principal, workspaceId);
    if (!scope.guest || ROLE_ORDER[role] > ROLE_ORDER.editor || operator) {
      await this.access.requireRole(principal, workspaceId, role, operator);
    }

    const resolved = await this.resolveChain(resource);
    const level = levelOn(scope, resolved.chain, resolved.grants);
    const needed: AccessLevel = role === 'admin' ? 'manage' : role === 'editor' ? 'edit' : 'view';
    if (accessRank(level) >= accessRank(needed)) {
      if (scope.bypass) this.auditBypass(principal, scope, resource, resolved.chain);
      return;
    }
    throw this.refusal(scope, resource, level, needed);
  }

  /** What `scope`'s holder may do with one page or project. */
  async levelFor(scope: AccessScope, resource: AccessResource): Promise<EffectiveAccessLevel> {
    const resolved = await this.resolveChain(resource);
    return levelOn(scope, resolved.chain, resolved.grants);
  }

  /** `levelFor`, throwing the guard's refusal when it falls short of `needed`. */
  async requireLevel(scope: AccessScope, resource: AccessResource, needed: AccessLevel): Promise<EffectiveAccessLevel> {
    const level = await this.levelFor(scope, resource);
    if (accessRank(level) < accessRank(needed)) throw this.refusal(scope, resource, level, needed);
    return level;
  }

  /** The subset of `ids` the scope may open — the one call behind every "drop what they cannot see". */
  async visibleDocumentIds(scope: AccessScope, ids: string[]): Promise<Set<string>> {
    const unique = [...new Set(ids)];
    if (scope.bypass || unique.length === 0) return new Set(unique);
    const rows = await this.prisma.document.findMany({
      where: { workspaceId: scope.workspaceId, id: { in: unique }, AND: [visibilityWhere(scope)] },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Which of `userIds` may open the resource — for handing someone work on a
   * page (a review, an assignment) or telling them about it. Non-members and
   * anyone the chain keeps out drop out; workspace and platform admins stay.
   */
  async whoCanOpen(resource: AccessResource, userIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Set();
    const { workspaceId, chain, grants } = await this.resolveChain(resource);
    const [members, memberships] = await Promise.all([
      this.prisma.workspaceMember.findMany({
        where: { workspaceId, userId: { in: unique } },
        select: { userId: true, role: true, user: { select: { isAdmin: true } } },
      }),
      this.prisma.userGroupMember.findMany({
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

  /**
   * A resource's chain, project first, with every grant on it. Ancestors that
   * no longer exist (no FK on parent_id) simply drop out of the chain.
   */
  async resolveChain(resource: AccessResource): Promise<ResolvedChain> {
    let workspaceId: string;
    let chain: ResolvedChain['chain'];
    if (resource.type === 'project') {
      const project = await this.prisma.project.findUnique({
        where: { id: resource.id },
        select: { workspaceId: true, name: true, restricted: true },
      });
      if (!project) throw new NotFoundException(t('error.project.notFound', { id: resource.id }));
      workspaceId = project.workspaceId;
      chain = [{ type: 'project', id: resource.id, restricted: project.restricted, title: project.name }];
    } else {
      const doc = await this.prisma.document.findUnique({
        where: { id: resource.id },
        select: { workspaceId: true, projectId: true, path: true },
      });
      if (!doc) throw new NotFoundException(t('error.document.notFound', { id: resource.id }));
      workspaceId = doc.workspaceId;
      const pathIds = doc.path.split('/').filter(Boolean);
      if (!pathIds.includes(resource.id)) pathIds.push(resource.id); // a `/pending/` row: itself alone
      const [project, nodes] = await Promise.all([
        this.prisma.project.findUnique({ where: { id: doc.projectId }, select: { name: true, restricted: true } }),
        this.prisma.document.findMany({
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
    const grants = await this.prisma.accessGrant.findMany({
      where: { resourceId: { in: chain.map((n) => n.id) } },
      select: { resourceId: true, subjectType: true, subjectId: true, level: true },
    });
    return { workspaceId, chain, grants };
  }

  /**
   * Rewrite `restricted_by` for a subtree (`documentId` and everything under
   * it) or a whole project, from the paths and switches as they stand now.
   * One statement, run inside whatever transaction moved a page, re-projected
   * it or flipped a switch, so no reader ever sees a page whose chain changed
   * but whose `restricted_by` did not. Rows whose value is already right are
   * left alone and keep their `acl_version`.
   */
  async recomputeRestrictedBy(
    target: { documentId: string } | { projectId: string },
    /** A caller's own interactive transaction, for code that opens one with `$transaction(fn)`. */
    db: Pick<Prisma.TransactionClient, '$executeRaw'> = this.prisma,
  ): Promise<number> {
    let filter: Prisma.Sql;
    if ('projectId' in target) {
      filter = Prisma.sql`d."project_id" = ${target.projectId}::uuid`;
    } else {
      const root = await this.prisma.document.findUnique({
        where: { id: target.documentId },
        select: { workspaceId: true, path: true },
      });
      if (!root) return 0;
      // A `/pending/` row has no subtree; a prefix match would claim every other one.
      filter =
        root.path.length > 1 && root.path !== '/pending/'
          ? Prisma.sql`d."workspace_id" = ${root.workspaceId}::uuid AND d."path" LIKE ${`${root.path}%`}`
          : Prisma.sql`d."id" = ${target.documentId}::uuid`;
    }
    return db.$executeRaw`
      WITH computed AS (
        SELECT d."id",
               ARRAY(
                 SELECT n."id" FROM (
                   SELECT p."id", -1 AS ord FROM "projects" p
                    WHERE p."id" = d."project_id" AND p."restricted"
                   UNION ALL
                   SELECT a."id", a."depth" FROM "documents" a
                    WHERE a."id"::text = ANY (string_to_array(trim(both '/' from d."path"), '/'))
                      AND a."restricted"
                 ) n ORDER BY n.ord
               ) AS rb
          FROM "documents" d
         WHERE ${filter}
      )
      UPDATE "documents" AS t
         SET "restricted_by" = c.rb,
             "acl_version" = t."acl_version" + 1
        FROM computed c
       WHERE t."id" = c."id"
         AND t."restricted_by" IS DISTINCT FROM c.rb`;
  }

  private refusal(
    scope: AccessScope,
    resource: AccessResource,
    level: EffectiveAccessLevel,
    needed: AccessLevel,
  ): NotFoundException | ForbiddenException {
    if (level === 'none') {
      if (scope.guest) {
        return new NotFoundException(
          t(resource.type === 'project' ? 'error.project.notFound' : 'error.document.notFound', { id: resource.id }),
        );
      }
      return new ForbiddenException({
        statusCode: 403,
        message: t(resource.type === 'project' ? 'error.access.projectRestricted' : 'error.access.pageRestricted'),
        canRequestAccess: true,
        resourceType: resource.type,
        resourceId: resource.id,
      });
    }
    return new ForbiddenException({
      statusCode: 403,
      message: t(needed === 'manage' ? 'error.access.manageRequired' : 'error.access.editRequired'),
      resourceType: resource.type,
      resourceId: resource.id,
      level,
      required: needed,
    });
  }

  /** An admin opening what no grant admits them to: allowed, and written down. */
  private auditBypass(
    principal: Principal,
    scope: AccessScope,
    resource: AccessResource,
    chain: ChainNode[],
  ): void {
    if (!chain.some((n) => n.restricted && scope.denied.has(n.id))) return;
    const key = `${principal.userId}:${resource.id}`;
    const now = Date.now();
    if (now - (this.bypassAudited.get(key) ?? 0) < BYPASS_AUDIT_WINDOW_MS) return;
    this.bypassAudited.set(key, now);
    if (this.bypassAudited.size > 10_000) this.bypassAudited.clear();
    void this.audit.record({
      workspaceId: scope.workspaceId,
      actor: principal.userId,
      action: 'acl.bypass',
      params: { resourceType: resource.type, resourceId: resource.id },
      ok: true,
    });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
