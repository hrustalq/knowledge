import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ACCESS_META,
  FEATURE_META,
  HISTORY_META,
  PLATFORM_ADMIN_META,
  PUBLIC_META,
  READ_KEY_OK_META,
  type AccessSpec,
  type WorkspaceSource,
} from './access.decorator.js';
import { WORKSPACE_SOURCES } from './workspace-sources.js';
import { AccessService } from './access.service.js';
import { FeaturesService } from './features.service.js';
import { type WorkspaceFeature, UUID_RE } from '@knowledge/contracts';
import { PermissionService, type AccessResource, type BranchRefs } from '../permissions/permission.service.js';
import type { Principal } from './principal.js';
import { t } from '../i18n/t.js';
import { bindTrace } from '@knowledge/observability';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);


/**
 * Where a page route names one of its branches or revisions (#474). The guard
 * holds each to the route's level, so a private branch is refused on every
 * route that takes one without each handler having to remember: a new route
 * that names a branch through one of these keys is covered as it lands, and
 * one that invents a new key must be added here.
 */
export const BRANCH_REFS = {
  branchNames: { query: ['branch'], body: ['branch', 'sourceBranch', 'targetBranch'] },
  branchIds: { params: ['branchId'] },
  revisionIds: { params: ['revisionId'], query: ['revision', 'revisionId', 'from', 'to', 'at'], body: ['revisionId', 'fromRevisionId'] },
} as const;

/** Request keys that ask for the knowledge base as of a point (#81), on any route. */
export const HISTORY_KEYS = ['asOf', 'knownAt'] as const;

type Req = { body?: Record<string, unknown>; query?: Record<string, unknown>; params?: Record<string, string> };

/** The branches and revisions a request names, by `BRANCH_REFS`. Ids that are not uuids are left for the handler to refuse. */
export function branchRefsOf(req: Req): BranchRefs {
  const read = (from: Partial<Record<'params' | 'query' | 'body', readonly string[]>>) =>
    (Object.keys(from) as ('params' | 'query' | 'body')[]).flatMap((where) =>
      (from[where] ?? []).map((key) => req[where]?.[key]).filter((v): v is string => typeof v === 'string' && v.length > 0),
    );
  return {
    branchNames: read(BRANCH_REFS.branchNames),
    branchIds: read(BRANCH_REFS.branchIds).filter((v) => UUID_RE.test(v)),
    revisionIds: read(BRANCH_REFS.revisionIds).filter((v) => UUID_RE.test(v)),
  };
}

/**
 * Phase 5 workspace ACL guard. Routes declare `@Access(role, source)`; the
 * guard resolves the target workspace in PostgreSQL and enforces membership
 * before the handler — and therefore before any graph/vector query — runs.
 * `@PlatformAdmin()` routes additionally require users.is_admin (403).
 * Routes without either require authentication only (no workspace resource).
 */
@Injectable()
export class AclGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly features: FeaturesService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();
    const principal: Principal = req.principal;

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_META, [ctx.getHandler(), ctx.getClass()])) {
      if (principal.mode !== 'dev' && !principal.isAdmin) {
        throw new ForbiddenException(t('error.auth.platformAdminRequired'));
      }
    }

    const spec = this.reflector.get<AccessSpec | undefined>(ACCESS_META, ctx.getHandler());
    if (!spec) {
      // No workspace to check a role in, so requireRole never sees these — a
      // read-only key would otherwise create workspaces or rename its owner.
      // A capture key is not a write key either (issue #73).
      const scope = principal.apiKey?.scope;
      if (
        scope &&
        scope !== 'write' &&
        !SAFE_METHODS.has(req.method) &&
        !this.reflector.getAllAndOverride<boolean>(READ_KEY_OK_META, [ctx.getHandler(), ctx.getClass()])
      ) {
        throw new ForbiddenException(
          t(scope === 'capture' ? 'error.auth.apiKeyCaptureOnly' : 'error.auth.apiKeyReadOnly', { role: t('role.editor') }),
        );
      }
      return true;
    }
    // A switched-off section (#604) is absent for everyone, the dev principal
    // included — so the dev shortcut resolves the workspace when a route has one.
    const feature = this.reflector.getAllAndOverride<WorkspaceFeature | undefined>(FEATURE_META, [ctx.getHandler(), ctx.getClass()]);
    if (principal.mode === 'dev') {
      if (feature) await this.features.require((await this.resolveTarget(spec, req)).workspaceId, feature);
      // AUTH_MODE=none returns before the workspace is ever resolved, so for
      // logging take whatever the request declared. Deliberately no DB lookup:
      // adding a query to the hot path to populate a log field is not a trade
      // worth making, and dev is where most logs are read.
      const declared = req.body?.workspaceId ?? req.query?.workspaceId;
      if (typeof declared === 'string') bindTrace({ workspaceId: declared });
      return true; // AUTH_MODE=none
    }

    const { workspaceId, resource, refs } = await this.resolveTarget(spec, req);
    // From here on every record carries the tenant — including records from
    // services that never receive a workspaceId argument at all.
    bindTrace({ workspaceId });
    if (resource) {
      // A page, its merge request or a project: the page level must cover the
      // route as well as the workspace role (#76).
      await this.permissions.requireResource(principal, workspaceId, resource, spec.role, spec.operator, {
        capture: spec.capture === true,
        capability: spec.capability,
      });
      // Then any of its branches the route names: a private one narrows the page
      // (#474). A source that stands for a revision (an ingestion job) names it.
      const named = spec.source === 'document' ? branchRefsOf(req) : refs;
      if (named) {
        await this.permissions.requireBranches(principal, workspaceId, resource.id, named, spec.role === 'viewer' ? 'view' : 'edit');
      }
    } else {
      await this.access.requireRole(principal, workspaceId, spec.role, spec.operator, {
        allowGuest: spec.guests === true,
        capture: spec.capture === true,
        capability: spec.capability,
      });
      // A connector follows its project's visibility (#555).
      if (spec.source === 'connector') {
        await this.permissions.requireConnectorVisible(principal, { connectorId: req.params.id });
      } else if (spec.source === 'connector-run') {
        await this.permissions.requireConnectorVisible(principal, { runId: req.params.runId });
      } else if (spec.source === 'assistant-thread') {
        await this.access.requireOwnThread(principal, { threadId: req.params.id });
      } else if (spec.source === 'assistant-message') {
        await this.access.requireOwnThread(principal, { messageId: req.params.id });
      }
    }
    // After the membership check, so a 404 here tells only a member that the section is off.
    if (feature) await this.features.require(workspaceId, feature);
    await this.requireHistory(ctx, spec, req, principal, workspaceId);
    return true;
  }

  /**
   * Page history (#958), by what the request asks for, so a new route is
   * covered as it lands: a route marked `@History()`, any read as of a point
   * (`asOf` / `knownAt`, query or body), and a GET on a page that names a
   * revision (`BRANCH_REFS`). `PermissionService.requireHistory` decides.
   */
  private async requireHistory(ctx: ExecutionContext, spec: AccessSpec, req: Req & { method?: string }, principal: Principal, workspaceId: string) {
    const named = (key: string) => [req.query?.[key], req.body?.[key]].some((v) => typeof v === 'string' && v.length > 0);
    const always = this.reflector.get<boolean | undefined>(HISTORY_META, ctx.getHandler()) === true || HISTORY_KEYS.some(named);
    const onPage = spec.source === 'document';
    const revisionIds = (onPage && req.method === 'GET' ? branchRefsOf(req).revisionIds : undefined) ?? [];
    if (!always && revisionIds.length === 0) return;
    await this.permissions.requireHistoryAs(principal, workspaceId, onPage ? req.params?.id : undefined, always ? undefined : revisionIds);
  }

  /**
   * The workspace, plus the resource page permissions apply to when the route
   * names one (and the revision it stands for, when the id is a revision's).
   */
  private async resolveTarget(
    spec: AccessSpec,
    req: Req,
  ): Promise<{ workspaceId: string; resource?: AccessResource; refs?: BranchRefs }> {
    if (spec.source === 'merge-request') {
      const { workspaceId, documentId } = await this.access.documentOfMergeRequest(this.uuid(req.params?.id, 'mergeRequest'));
      return { workspaceId, resource: { type: 'document', id: documentId } };
    }
    // Held to its page, as creating one is (#1090).
    if (spec.source === 'share-link') {
      const { workspaceId, documentId } = await this.access.documentOfShareLink(this.uuid(req.params?.id, 'shareLink'));
      return { workspaceId, resource: { type: 'document', id: documentId } };
    }
    if (spec.source === 'job') {
      const { workspaceId, documentId, revisionId } = await this.access.revisionOfIngestionJob(this.uuid(req.params?.id, 'job'));
      return { workspaceId, resource: { type: 'document', id: documentId }, refs: { branchNames: [], branchIds: [], revisionIds: [revisionId] } };
    }
    if (spec.source === 'workflow-run') return this.access.rootOfWorkflowRun(this.uuid(req.params?.id, 'workflowRun'));
    const workspaceId = await this.resolveWorkspace(spec.source, req);
    if (spec.source === 'document' || spec.source === 'project') {
      return { workspaceId, resource: { type: spec.source, id: req.params?.id as string } };
    }
    return { workspaceId };
  }

  // `subject` is a catalog key (subject.*), not an English fragment: Russian
  // needs the noun declined, so it is translated rather than concatenated.
  private uuid(value: unknown, subject: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException(t('error.invalidUuid', { subject: t(`subject.${subject}`) }));
    }
    return value;
  }

  private intId(value: unknown, subject: string): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new BadRequestException(t('error.invalidNumericId', { subject: t(`subject.${subject}`) }));
    }
    return n;
  }

  private async resolveWorkspace(source: WorkspaceSource, req: Req): Promise<string> {
    if (source === 'body') return this.uuid(req.body?.workspaceId, 'workspaceId');
    if (source === 'query') return this.uuid(req.query?.workspaceId, 'workspaceId');
    if (source === 'workspace') return this.access.workspaceExists(this.uuid(req.params?.id, 'workspace'));
    const row = WORKSPACE_SOURCES[source];
    const raw = req.params?.[row.param ?? 'id'];
    return this.access.workspaceOf(source, row.int ? this.intId(raw, row.subject) : this.uuid(raw, row.subject));
  }
}
