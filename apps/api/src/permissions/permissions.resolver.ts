import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PERMISSION_ACTIONS, WORKSPACE_ACTIONS, type MePermissionsResponse, type PermissionRule } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { AccessService } from '../auth/access.service.js';
import { isPlatformAdmin, type Principal } from '../auth/principal.js';
import { workspaceCreationRefusal } from '../auth/workspace-creation.js';
import { allowed, PermissionService } from './permission.service.js';

/**
 * The answers behind `GET /v1/me/permissions` (#1296): each workspace action
 * of `PERMISSION_ACTIONS`, asked of the guard that enforces it, without
 * throwing — `PermissionService.projectSettingsAccess` is the pattern. Role
 * actions go through `requireRole`, so key narrowing, enforced SSO and the dev
 * principal answer as they do on a route. Never `requireResource`, which
 * audits an admin's bypass per resource.
 */
@Injectable()
export class PermissionsResolver {
  constructor(
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async workspaceGrants(principal: Principal, workspaceId: string): Promise<MePermissionsResponse> {
    const answers = await Promise.all(WORKSPACE_ACTIONS.map((action) => this.allows(principal, workspaceId, PERMISSION_ACTIONS[action])));
    return Object.fromEntries(WORKSPACE_ACTIONS.map((action, i) => [action, answers[i]!])) as MePermissionsResponse;
  }

  private async allows(principal: Principal, workspaceId: string, rule: PermissionRule): Promise<boolean> {
    if (!('role' in rule)) {
      if ('special' in rule && rule.special === 'platform-admin') return isPlatformAdmin(principal);
      if ('special' in rule && rule.special === 'workspace-create') {
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
