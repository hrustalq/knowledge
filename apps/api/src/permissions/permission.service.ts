import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  accessRank,
  DEFAULT_LOCALE,
  type AccessLevel,
  type AccessResourceType,
  type EffectiveAccessLevel,
  type MemberCapability,
  type WorkspaceRole,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import type { DocumentAclFilter } from '../common/document-acl.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../auth/access.service.js';
import { AuditService } from '../auth/audit.service.js';
import { ROLE_ORDER, type Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import {
  canSeeProject,
  clampToAudience,
  hidesAnything,
  levelOn,
  visibilityWhere,
  type AccessScope,
  type Audience,
  type ChainNode,
  type GrantRow,
} from './access-scope.js';
import { resolveChain, restrictedNodeIds, whoCanOpen, type AccessResource, type ResolvedChain } from './acl-read.js';
import { branchLevel, type BranchAclRow } from './branch-access.js';

/** What a request names on one page: branches by name or id, revisions by id (#474). */
export interface BranchRefs {
  branchNames?: string[];
  branchIds?: string[];
  revisionIds?: string[];
}

export type { AccessResource, ResolvedChain } from './acl-read.js';

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
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * The caller's visibility over one workspace. Three small reads: the
   * membership, their groups, and the restricted nodes against their grants.
   * A non-member who is not a platform admin is refused here exactly as
   * `requireRole` would refuse them.
   */
  async scopeFor(principal: Principal, workspaceId: string): Promise<AccessScope> {
    // A capture key reads like a read key; `requireResource` lifts it for the
    // one call that passes `capture` (issue #73).
    const readOnly = principal.apiKey !== undefined && principal.apiKey.scope !== 'write';
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

  /**
   * `scopeFor` for someone who is not the caller: the author of a revision
   * being finalized by a merge or a sweeper (#483). Refused like `scopeFor`
   * when they are no longer a member.
   */
  async scopeForUser(userId: string, workspaceId: string): Promise<AccessScope> {
    return this.scopeFor(await this.access.principalFor(userId, DEFAULT_LOCALE), workspaceId);
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
    opts: { capture?: boolean; capability?: MemberCapability } = {},
  ): Promise<void> {
    if (principal.apiKey) this.access.requireKeyAllows(principal.apiKey, workspaceId, role, opts);
    if (principal.mode === 'dev') return;
    const read = await this.scopeFor(principal, workspaceId);
    // requireKeyAllows has just let a capture key through for this call, so its
    // page level is the person's own, not capped at view.
    const scope = opts.capture && principal.apiKey?.scope === 'capture' ? { ...read, readOnly: false } : read;
    if (!scope.guest || ROLE_ORDER[role] > ROLE_ORDER.editor || operator || opts.capability) {
      await this.access.requireRole(principal, workspaceId, role, operator, opts);
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

  /**
   * The guard's half for a route whose `:id` is a connector or one of its runs,
   * after the workspace role passed (#555). A connector belongs to its project
   * (#553), so one in a project the caller cannot open reads as not found — the
   * code tools' rule, and no project id or name in the answer. Builds a scope
   * only when the project is restricted, so an unrestricted workspace pays one
   * indexed read.
   */
  async requireConnectorVisible(principal: Principal, ref: { connectorId: string } | { runId: string }): Promise<void> {
    if (principal.mode === 'dev') return;
    const project = { select: { id: true, restricted: true } } as const;
    const row =
      'connectorId' in ref
        ? await this.prisma.connector.findUnique({
            where: { id: ref.connectorId },
            select: { workspaceId: true, project },
          })
        : await this.prisma.connectorRun
            .findUnique({ where: { id: ref.runId }, select: { workspaceId: true, connector: { select: { project } } } })
            .then((run) => run && { workspaceId: run.workspaceId, project: run.connector.project });
    if (row && (!row.project.restricted || canSeeProject(await this.scopeFor(principal, row.workspaceId), row.project))) {
      return;
    }
    throw new NotFoundException(
      'connectorId' in ref
        ? t('error.connector.notFound', { id: ref.connectorId })
        : t('error.connector.runNotFound', { id: ref.runId }),
    );
  }

  /**
   * Hold every branch and revision a request names on `documentId` to
   * `needed` (#474), after the page itself passed. Only private branches cost
   * a scope; a request that names none, or only open ones, reads two indexed
   * rows at most. A ref from another page is not this check's business — the
   * service 404s it.
   */
  async requireBranches(
    principal: Principal,
    workspaceId: string,
    documentId: string,
    refs: BranchRefs,
    needed: 'view' | 'edit',
  ): Promise<void> {
    if (principal.mode === 'dev') return;
    const named = await this.privateBranchesNamed(documentId, refs);
    if (named.length === 0) return;
    await this.assertBranches(principal, await this.scopeFor(principal, workspaceId), named, needed);
  }

  /**
   * The ids of the page's branches `scope` may read, for the lists (branches,
   * revisions, collab drafts). Every branch when none is private.
   */
  async visibleBranchIds(scope: AccessScope, documentId: string): Promise<Set<string>> {
    const branches = await this.prisma.documentBranch.findMany({
      where: { documentId },
      select: { id: true, ownerId: true, restricted: true },
    });
    const grants = await this.branchGrants(branches.filter((b) => b.restricted).map((b) => b.id));
    return new Set(branches.filter((b) => branchLevel(scope, b, grants) !== 'none').map((b) => b.id));
  }

  private async privateBranchesNamed(documentId: string, refs: BranchRefs): Promise<BranchAclRow[]> {
    const revisionIds = refs.revisionIds ?? [];
    const viaRevisions = revisionIds.length
      ? await this.prisma.documentRevision.findMany({
          where: { id: { in: revisionIds }, documentId, branchId: { not: null } },
          select: { branchId: true },
        })
      : [];
    const ids = [...(refs.branchIds ?? []), ...viaRevisions.map((r) => r.branchId!)];
    const names = refs.branchNames ?? [];
    if (ids.length === 0 && names.length === 0) return [];
    return this.prisma.documentBranch.findMany({
      where: {
        documentId,
        restricted: true,
        OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(names.length ? [{ name: { in: names } }] : [])],
      },
      select: { id: true, ownerId: true, restricted: true },
    });
  }

  private async branchGrants(branchIds: string[]): Promise<GrantRow[]> {
    if (branchIds.length === 0) return [];
    return this.prisma.accessGrant.findMany({
      where: { resourceType: 'branch', resourceId: { in: branchIds } },
      select: { resourceId: true, subjectType: true, subjectId: true, level: true },
    });
  }

  /**
   * A refused branch reads like a refused page, minus the access request
   * (#474: a branch is shared by its owner, not asked for): a member gets 403
   * naming nothing, a guest 404. An admin let in by nothing but the bypass is
   * audited, as for a page.
   */
  private async assertBranches(
    principal: Principal,
    scope: AccessScope,
    branches: BranchAclRow[],
    needed: 'view' | 'edit',
  ): Promise<void> {
    const grants = await this.branchGrants(branches.map((b) => b.id));
    for (const branch of branches) {
      const level = branchLevel(scope, branch, grants);
      if (level === 'none' || (needed === 'edit' && level !== 'edit')) {
        if (level === 'none' && scope.guest) throw new NotFoundException(t('error.branch.hidden'));
        throw new ForbiddenException({
          statusCode: 403,
          message: t(level === 'none' ? 'error.access.branchRestricted' : 'error.access.editRequired'),
          canRequestAccess: false,
          resourceType: 'branch',
          resourceId: branch.id,
        });
      }
      if (scope.bypass && branchLevel({ ...scope, bypass: false }, branch, grants) === 'none') {
        this.auditBranchBypass(principal, scope, branch.id);
      }
    }
  }

  private auditBranchBypass(principal: Principal, scope: AccessScope, branchId: string): void {
    const key = `${principal.userId}:${branchId}`;
    const now = Date.now();
    if (now - (this.bypassAudited.get(key) ?? 0) < BYPASS_AUDIT_WINDOW_MS) return;
    this.bypassAudited.set(key, now);
    void this.audit.record({
      workspaceId: scope.workspaceId,
      actor: principal.userId,
      action: 'acl.bypass',
      params: { resourceType: 'branch', resourceId: branchId },
      ok: true,
    });
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

  /**
   * Whether `scope`'s holder may place a new page here: edit on the parent, or
   * on the project for a root page. A page created under a node inherits its
   * restrictions, so this is the same question as editing the node — and it
   * keeps a hidden parent id from being probed by creating under it.
   */
  async requireCreateUnder(scope: AccessScope, at: { projectId: string; parentId?: string }): Promise<void> {
    await this.requireLevel(
      scope,
      at.parentId ? { type: 'document', id: at.parentId } : { type: 'project', id: at.projectId },
      'edit',
    );
  }

  /**
   * An admin's read of a page outside the guard — an assistant tool, say —
   * audited the way `requireResource` audits one through a route. A no-op for
   * anyone who is not bypassing, and for a page nothing restricts from them.
   */
  async auditBypassRead(principal: Principal, scope: AccessScope, resource: AccessResource): Promise<void> {
    if (!scope.bypass || principal.mode === 'dev' || scope.denied.size === 0) return;
    const { chain } = await this.resolveChain(resource);
    this.auditBypass(principal, scope, resource, chain);
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
   * `scope` clamped to who will read the output (#76, `clampToAudience`): a
   * page survives only when its `restricted_by` is a subset of the
   * destination's. A destination that is gone, or in another workspace, clamps
   * to the workspace audience — the narrowest, never the widest.
   *
   * Read from PG on every call, like `scopeFor`: a tool loop asks per call, so
   * a restriction placed mid-run holds from the next one.
   */
  async audienceScope(scope: AccessScope, audience: Audience): Promise<AccessScope> {
    const [restricted, destination] = await Promise.all([
      restrictedNodeIds(this.prisma, scope.workspaceId),
      audience.kind === 'document'
        ? this.prisma.document.findUnique({
            where: { id: audience.documentId },
            select: { workspaceId: true, restrictedBy: true },
          })
        : null,
    ]);
    const audienceNodes =
      destination && destination.workspaceId === scope.workspaceId ? new Set(destination.restrictedBy) : new Set<string>();
    return clampToAudience(scope, restricted, audienceNodes);
  }

  /**
   * A tool call's scope: the caller's, asked afresh per call so a grant
   * revoked mid-turn holds from the next one, and clamped to the run's
   * audience when its output is read by more people than the caller (#76).
   */
  async toolScope(ctx: { principal: Principal; workspaceId: string; audience?: Audience }): Promise<AccessScope> {
    const scope = await this.scopeFor(ctx.principal, ctx.workspaceId);
    return ctx.audience ? this.audienceScope(scope, ctx.audience) : scope;
  }

  /**
   * The scope as a store filter for ArcadeDB and OpenSearch (#76): the pages a
   * member may not open, or the pages a guest may. Read from PG on every call,
   * so a grant changed a second ago already holds in the stores' predicates —
   * the `aclNodes` stamps the re-stamp sweeper writes are only a prefilter.
   *
   * A failure here fails the read: there is no fallback to "unfiltered".
   */
  async documentFilterFor(scope: AccessScope): Promise<DocumentAclFilter> {
    if (!hidesAnything(scope)) return { kind: 'all' };
    const max = this.config.get('ACL_DENY_LIST_MAX', { infer: true });
    if (scope.guest) {
      const rows = await this.prisma.document.findMany({
        where: { workspaceId: scope.workspaceId, AND: [visibilityWhere(scope)] },
        select: { id: true },
      });
      return { kind: 'allow', documentIds: new Set(rows.map((r) => r.id)), pushdown: rows.length <= max };
    }
    const nodeIds = [...scope.denied];
    const rows = await this.prisma.document.findMany({
      where: { workspaceId: scope.workspaceId, restrictedBy: { hasSome: nodeIds } },
      select: { id: true },
    });
    // Restricted nodes with nothing under them hide nothing.
    if (rows.length === 0) return { kind: 'all' };
    return { kind: 'deny', documentIds: new Set(rows.map((r) => r.id)), nodeIds, pushdown: rows.length <= max };
  }

  /**
   * Which of `userIds` may open the resource — for handing someone work on a
   * page (a review, an assignment) or telling them about it. Non-members and
   * anyone the chain keeps out drop out; workspace and platform admins stay.
   */
  async whoCanOpen(resource: AccessResource, userIds: string[]): Promise<Set<string>> {
    return whoCanOpen(this.prisma, resource, userIds);
  }

  /**
   * A resource's chain, project first, with every grant on it. Ancestors that
   * no longer exist (no FK on parent_id) simply drop out of the chain.
   */
  async resolveChain(resource: AccessResource): Promise<ResolvedChain> {
    return resolveChain(this.prisma, resource);
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
