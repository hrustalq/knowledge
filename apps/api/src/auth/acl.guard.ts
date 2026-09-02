import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCESS_META, PLATFORM_ADMIN_META, PUBLIC_META, type AccessSpec } from './access.decorator.js';
import { AccessService } from './access.service.js';
import type { Principal } from './principal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();
    const principal: Principal = req.principal;

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_META, [ctx.getHandler(), ctx.getClass()])) {
      if (principal.mode !== 'dev' && !principal.isAdmin) {
        throw new ForbiddenException('Requires platform admin');
      }
    }

    const spec = this.reflector.get<AccessSpec | undefined>(ACCESS_META, ctx.getHandler());
    if (!spec) return true;
    if (principal.mode === 'dev') return true; // AUTH_MODE=none

    const workspaceId = await this.resolveWorkspace(spec, req);
    await this.access.requireRole(principal, workspaceId, spec.role, spec.operator);
    return true;
  }

  private async resolveWorkspace(
    spec: AccessSpec,
    req: { body?: Record<string, unknown>; query?: Record<string, unknown>; params?: Record<string, string> },
  ): Promise<string> {
    const uuid = (value: unknown, what: string): string => {
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new BadRequestException(`${what} must be a UUID`);
      }
      return value;
    };
    switch (spec.source) {
      case 'body':
        return uuid(req.body?.workspaceId, 'workspaceId');
      case 'query':
        return uuid(req.query?.workspaceId, 'workspaceId');
      case 'document':
        return this.access.workspaceOfDocument(uuid(req.params?.id, 'document id'));
      case 'merge-request':
        return this.access.workspaceOfMergeRequest(uuid(req.params?.id, 'merge request id'));
      case 'job':
        return this.access.workspaceOfJob(uuid(req.params?.id, 'job id'));
      case 'workspace':
        return this.access.workspaceExists(uuid(req.params?.id, 'workspace id'));
    }
  }
}
