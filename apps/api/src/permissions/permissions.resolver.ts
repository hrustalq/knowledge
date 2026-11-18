import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  accessRank,
  PERMISSION_ACTIONS,
  resourceActions,
  WORKSPACE_ACTIONS,
  type DocumentAction,
  type DocumentPermissionsResponse,
  type MePermissionsResponse,
  type MergeRequestAction,
  type MergeRequestPermissions,
  type PermissionRule,
  type ProjectAction,
  type ProjectPermissions,
  type ResourceAction,
  type WorkspaceRole,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { AccessService } from '../auth/access.service.js';
import { isPlatformAdmin, ROLE_ORDER, type Principal } from '../auth/principal.js';
import { workspaceCreationRefusal } from '../auth/workspace-creation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { levelOn } from './access-scope.js';
import type { AccessResource } from './acl-read.js';
import { branchLevel } from './branch-access.js';
import { allowed, PermissionService } from './permission.service.js';

const DOCUMENT_ACTIONS = resourceActions<DocumentAction>('document', 'branch');
const PROJECT_ACTIONS = resourceActions<ProjectAction>('project');
const MERGE_REQUEST_ACTIONS = resourceActions<MergeRequestAction>('merge-request');

/**
 * The answers behind the permission catalogue (#1296, #1298): each action of
 * `PERMISSION_ACTIONS`, asked of the guard that enforces it, without throwing
 * — `allowed(guard)`. Role actions go
 * through `requireRole`, so key narrowing, enforced SSO and the dev principal
 * answer as they do on a route. Never `requireResource`, which audits an
 * admin's bypass per resource.
 */
@Injectable()
export class PermissionsResolver {
  constructor(
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {}

  async workspaceGrants(principal: Principal, workspaceId: string): Promise<MePermissionsResponse> {
    const answers = await Promise.all(WORKSPACE_ACTIONS.map((action) => this.allows(principal, workspaceId, PERMISSION_ACTIONS[action])));
    return Object.fromEntries(WORKSPACE_ACTIONS.map((action, i) => [action, answers[i]!])) as MePermissionsResponse;
  }

  /** `GET /v1/documents/:id/permissions`; `branch` is the `?branch=` the page is read on. */
  forDocument(principal: Principal, documentId: string, branch?: string): Promise<DocumentPermissionsResponse> {
    return this.forResource(principal, { type: 'document', id: documentId }, DOCUMENT_ACTIONS, branch);
  }

  /** The `permissions` of `GET /v1/projects/:id`. */
  forProject(principal: Principal, projectId: string): Promise<ProjectPermissions> {
    return this.forResource(principal, { type: 'project', id: projectId }, PROJECT_ACTIONS);
  }

  /** The `permissions` of `GET /v1/merge-requests/:id`: the guard holds a merge request to its page. */
  forMergeRequest(principal: Principal, documentId: string): Promise<MergeRequestPermissions> {
    return this.forResource(principal, { type: 'document', id: documentId }, MERGE_REQUEST_ACTIONS);
  }

  /**
   * One resource's actions, from one scope and one chain. `{ role, level }`
   * is `requireResource` asked without throwing or auditing: the workspace
   * half (a guest skips it on a viewer or editor route), then `levelOn`.
   */
  private async forResource<A extends ResourceAction>(
    principal: Principal,
    resource: AccessResource,
    actions: A[],
    branch?: string,
  ): Promise<Record<A, boolean>> {
    const resolved = await this.permissions.resolveChain(resource);
    const { workspaceId } = resolved;
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const level = levelOn(scope, resolved.chain, resolved.grants);
    const gates = new Map<WorkspaceRole, Promise<boolean>>();
    const gate = (role: WorkspaceRole): Promise<boolean> => {
      if (!gates.has(role)) {
        gates.set(
          role,
          allowed(
            (async () => {
              if (principal.apiKey) this.access.requireKeyAllows(principal.apiKey, workspaceId, role, {});
              if (!scope.guest || ROLE_ORDER[role] > ROLE_ORDER.editor) await this.access.requireRole(principal, workspaceId, role);
            })(),
          ),
        );
      }
      return gates.get(role)!;
    };
    const answers = await Promise.all(
      actions.map(async (action): Promise<boolean> => {
        const rule: PermissionRule = PERMISSION_ACTIONS[action];
        if (!('level' in rule)) return allowed(this.permissions.requireProjectManage(principal, resource.id));
        if (!(await gate(rule.role)) || accessRank(level) < accessRank(rule.level)) return false;
        if (rule.special === 'history') return allowed(this.permissions.requireHistory(scope, resource.id));
        if (rule.special === 'branch') return this.mayWriteBranch(scope, resource.id, branch);
        return true;
      }),
    );
    return Object.fromEntries(actions.map((action, i) => [action, answers[i]!])) as Record<A, boolean>;
  }

  /** `requireBranches(…, 'edit')` for the branch named; the default branch, or one that is not private, adds nothing. */
  private async mayWriteBranch(scope: Parameters<typeof branchLevel>[0], documentId: string, name?: string): Promise<boolean> {
    if (!name) return true;
    const row = await this.prisma.documentBranch.findFirst({
      where: { documentId, name, restricted: true },
      select: { id: true, ownerId: true, restricted: true },
    });
    if (!row) return true;
    const grants = await this.prisma.accessGrant.findMany({
      where: { resourceType: 'branch', resourceId: row.id },
      select: { resourceId: true, subjectType: true, subjectId: true, level: true },
    });
    return branchLevel(scope, row, grants) === 'edit';
  }

  private async allows(principal: Principal, workspaceId: string, rule: PermissionRule): Promise<boolean> {
    if ('level' in rule) throw new Error('a per-resource action has no workspace answer');
    if (!('role' in rule)) {
      if (rule.special === 'platform-admin') return isPlatformAdmin(principal);
      if (rule.special === 'workspace-create') {
        return workspaceCreationRefusal(principal, this.config.get('AUTH_SIGNUP_ENABLED', { infer: true }) === true) === null;
      }
      throw new Error('a per-resource action has no workspace answer');
    }
    const role = this.access.requireRole(principal, workspaceId, rule.role, rule.operator === true, {
      allowGuest: rule.guests === true,
      capability: rule.capability,
    });
    if (!(await allowed(role))) return false;
    if (rule.special === 'history') return allowed(this.permissions.requireHistoryAs(principal, workspaceId));
    if (rule.special === 'publish-direct') return this.permissions.mayPublishDirect(principal, workspaceId);
    return true;
  }
}
