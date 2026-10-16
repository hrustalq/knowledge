import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ACCESS_META, PLATFORM_ADMIN_META, PUBLIC_META, READ_KEY_OK_META, type AccessSpec } from './access.decorator.js';
import { AccessService } from './access.service.js';
import { PermissionService, type AccessResource } from '../permissions/permission.service.js';
import type { Principal } from './principal.js';
import { t } from '../i18n/t.js';
import { bindTrace } from '@knowledge/observability';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    private readonly permissions: PermissionService,
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
    if (principal.mode === 'dev') {
      // AUTH_MODE=none returns before the workspace is ever resolved, so for
      // logging take whatever the request declared. Deliberately no DB lookup:
      // adding a query to the hot path to populate a log field is not a trade
      // worth making, and dev is where most logs are read.
      const declared = req.body?.workspaceId ?? req.query?.workspaceId;
      if (typeof declared === 'string') bindTrace({ workspaceId: declared });
      return true; // AUTH_MODE=none
    }

    const { workspaceId, resource } = await this.resolveTarget(spec, req);
    // From here on every record carries the tenant — including records from
    // services that never receive a workspaceId argument at all.
    bindTrace({ workspaceId });
    if (resource) {
      // A page, its merge request or a project: the page level must cover the
      // route as well as the workspace role (#76).
      await this.permissions.requireResource(principal, workspaceId, resource, spec.role, spec.operator, {
        capture: spec.capture === true,
      });
    } else {
      await this.access.requireRole(principal, workspaceId, spec.role, spec.operator, {
        allowGuest: spec.guests === true,
        capture: spec.capture === true,
      });
    }
    return true;
  }

  /** The workspace, plus the resource page permissions apply to when the route names one. */
  private async resolveTarget(
    spec: AccessSpec,
    req: { body?: Record<string, unknown>; query?: Record<string, unknown>; params?: Record<string, string> },
  ): Promise<{ workspaceId: string; resource?: AccessResource }> {
    switch (spec.source) {
      case 'document': {
        const id = this.uuid(req.params?.id, 'document');
        return { workspaceId: await this.access.workspaceOfDocument(id), resource: { type: 'document', id } };
      }
      case 'merge-request': {
        const { workspaceId, documentId } = await this.access.documentOfMergeRequest(
          this.uuid(req.params?.id, 'mergeRequest'),
        );
        return { workspaceId, resource: { type: 'document', id: documentId } };
      }
      case 'project': {
        const id = this.uuid(req.params?.id, 'project');
        return { workspaceId: await this.access.workspaceOfProject(id), resource: { type: 'project', id } };
      }
      default:
        return { workspaceId: await this.resolveWorkspace(spec, req) };
    }
  }

  // `subject` is a catalog key (subject.*), not an English fragment: Russian
  // needs the noun declined, so it is translated rather than concatenated.
  private uuid(value: unknown, subject: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new BadRequestException(t('error.invalidUuid', { subject: t(`subject.${subject}`) }));
    }
    return value;
  }

  private async resolveWorkspace(
    spec: AccessSpec,
    req: { body?: Record<string, unknown>; query?: Record<string, unknown>; params?: Record<string, string> },
  ): Promise<string> {
    const uuid = (value: unknown, subject: string): string => this.uuid(value, subject);
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
      case 'job':
        return this.access.workspaceOfJob(uuid(req.params?.id, 'job'));
      case 'assistant-thread':
        return this.access.workspaceOfAssistantThread(uuid(req.params?.id, 'assistantThread'));
      case 'assistant-message':
        return this.access.workspaceOfAssistantMessage(uuid(req.params?.id, 'assistantMessage'));
      case 'knowledge-issue':
        return this.access.workspaceOfKnowledgeIssue(uuid(req.params?.id, 'knowledgeIssue'));
      case 'ai-skill':
        return this.access.workspaceOfAiSkill(uuid(req.params?.id, 'skill'));
      case 'ai-plugin':
        return this.access.workspaceOfAiPlugin(uuid(req.params?.id, 'plugin'));
      case 'ai-provider':
        return this.access.workspaceOfAiProvider(uuid(req.params?.id, 'provider'));
      case 'agent-trigger':
        return this.access.workspaceOfAgentTrigger(uuid(req.params?.id, 'agentTrigger'));
      case 'agent-learning':
        return this.access.workspaceOfAgentLearning(uuid(req.params?.id, 'agentLearning'));
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
      case 'template':
        return this.access.workspaceOfTemplate(uuid(req.params?.id, 'template'));
      case 'share-link':
        return this.access.workspaceOfShareLink(uuid(req.params?.id, 'shareLink'));
      case 'site':
        return this.access.workspaceOfSite(uuid(req.params?.id, 'site'));
      case 'site-version':
        return this.access.workspaceOfSiteVersion(uuid(req.params?.id, 'siteVersion'));
      case 'site-domain':
        return this.access.workspaceOfSiteDomain(uuid(req.params?.id, 'siteDomain'));
      case 'export':
        return this.access.workspaceOfExport(uuid(req.params?.id, 'export'));
      case 'connector':
        return this.access.workspaceOfConnector(uuid(req.params?.id, 'connector'));
      case 'connector-run':
        return this.access.workspaceOfConnectorRun(uuid(req.params?.runId, 'connectorRun'));
      case 'chat-integration':
        return this.access.workspaceOfChatIntegration(uuid(req.params?.id, 'chatIntegration'));
      case 'chat-binding':
        return this.access.workspaceOfChatBinding(uuid(req.params?.id, 'chatBinding'));
      case 'chat-subscription':
        return this.access.workspaceOfChatSubscription(uuid(req.params?.id, 'chatSubscription'));
      case 'group':
        return this.access.workspaceOfGroup(uuid(req.params?.id, 'group'));
      case 'access-request':
        return this.access.workspaceOfAccessRequest(uuid(req.params?.id, 'accessRequest'));
      case 'capture':
        return this.access.workspaceOfCapture(uuid(req.params?.id, 'capture'));
      case 'workspace':
        return this.access.workspaceExists(uuid(req.params?.id, 'workspace'));
      case 'document':
      case 'merge-request':
      case 'project':
        throw new Error(`resolveTarget handles ${spec.source}`);
    }
  }
}
