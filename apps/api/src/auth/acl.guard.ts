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
import { t } from '../i18n/t.js';
import { bindTrace } from '@knowledge/observability';

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
        throw new ForbiddenException(t('error.auth.platformAdminRequired'));
      }
    }

    const spec = this.reflector.get<AccessSpec | undefined>(ACCESS_META, ctx.getHandler());
    if (!spec) return true;
    if (principal.mode === 'dev') {
      // AUTH_MODE=none returns before the workspace is ever resolved, so for
      // logging take whatever the request declared. Deliberately no DB lookup:
      // adding a query to the hot path to populate a log field is not a trade
      // worth making, and dev is where most logs are read.
      const declared = req.body?.workspaceId ?? req.query?.workspaceId;
      if (typeof declared === 'string') bindTrace({ workspaceId: declared });
      return true; // AUTH_MODE=none
    }

    const workspaceId = await this.resolveWorkspace(spec, req);
    // From here on every record carries the tenant — including records from
    // services that never receive a workspaceId argument at all.
    bindTrace({ workspaceId });
    await this.access.requireRole(principal, workspaceId, spec.role, spec.operator);
    return true;
  }

  private async resolveWorkspace(
    spec: AccessSpec,
    req: { body?: Record<string, unknown>; query?: Record<string, unknown>; params?: Record<string, string> },
  ): Promise<string> {
    // `subject` is a catalog key (subject.*), not an English fragment: Russian
    // needs the noun declined, so it is translated rather than concatenated.
    const uuid = (value: unknown, subject: string): string => {
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new BadRequestException(t('error.invalidUuid', { subject: t(`subject.${subject}`) }));
      }
      return value;
    };
    // Saved filters are the one resource keyed by an integer (they are shown
    // and linked as `#7`), so they need their own parse — uuid() would reject
    // every valid id.
    const intId = (value: unknown, subject: string): number => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new BadRequestException(t('error.invalidNumericId', { subject: t(`subject.${subject}`) }));
      }
      return n;
    };
    switch (spec.source) {
      case 'body':
        return uuid(req.body?.workspaceId, 'workspaceId');
      case 'query':
        return uuid(req.query?.workspaceId, 'workspaceId');
      case 'document':
        return this.access.workspaceOfDocument(uuid(req.params?.id, 'document'));
      case 'merge-request':
        return this.access.workspaceOfMergeRequest(uuid(req.params?.id, 'mergeRequest'));
      case 'job':
        return this.access.workspaceOfJob(uuid(req.params?.id, 'job'));
      case 'project':
        return this.access.workspaceOfProject(uuid(req.params?.id, 'project'));
      case 'assistant-thread':
        return this.access.workspaceOfAssistantThread(uuid(req.params?.id, 'assistantThread'));
      case 'ai-skill':
        return this.access.workspaceOfAiSkill(uuid(req.params?.id, 'skill'));
      case 'ai-plugin':
        return this.access.workspaceOfAiPlugin(uuid(req.params?.id, 'plugin'));
      case 'ai-provider':
        return this.access.workspaceOfAiProvider(uuid(req.params?.id, 'provider'));
      case 'saved-filter':
        return this.access.workspaceOfSavedFilter(intId(req.params?.filterId, 'savedFilter'));
      case 'glossary-term':
        return this.access.workspaceOfGlossaryTerm(uuid(req.params?.id, 'glossaryTerm'));
      case 'source-policy':
        return this.access.workspaceOfSourcePolicy(uuid(req.params?.id, 'sourcePolicy'));
      case 'import':
        return this.access.workspaceOfImport(uuid(req.params?.id, 'import'));
      case 'workflow-definition':
        return this.access.workspaceOfWorkflowDefinition(uuid(req.params?.id, 'workflow'));
      case 'workflow-run':
        return this.access.workspaceOfWorkflowRun(uuid(req.params?.id, 'workflowRun'));
      case 'connector':
        return this.access.workspaceOfConnector(uuid(req.params?.id, 'connector'));
      case 'connector-run':
        return this.access.workspaceOfConnectorRun(uuid(req.params?.runId, 'connectorRun'));
      case 'workspace':
        return this.access.workspaceExists(uuid(req.params?.id, 'workspace'));
    }
  }
}
