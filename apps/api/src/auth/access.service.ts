import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Locale, WorkspaceRole } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { DEV_PRINCIPAL, ROLE_ORDER, type Principal } from './principal.js';
import { t } from '../i18n/t.js';

/**
 * Phase 5 ACLs (plan.md §11): authorization is resolved in PostgreSQL BEFORE
 * any graph/vector query runs. The mandatory workspaceId predicate that
 * GraphService injects into every graph statement is the second half of the
 * same guarantee (plan.md §6 security note).
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async requireRole(
    principal: Principal,
    workspaceId: string,
    role: WorkspaceRole,
    operator = false,
  ): Promise<void> {
    // A key narrows its owner before anything widens them: checked ahead of the
    // platform-admin shortcut, or an admin's read-only key would write anyway.
    if (principal.apiKey) this.requireKeyAllows(principal.apiKey, workspaceId, role);
    if (principal.mode === 'dev') return; // AUTH_MODE=none — full access
    if (principal.isAdmin) return; // platform admin — implicit admin + operator everywhere
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: principal.userId } },
    });
    if (!member) throw new ForbiddenException(t('error.auth.notMember', { workspaceId }));
    if ((ROLE_ORDER[member.role as WorkspaceRole] ?? -1) < ROLE_ORDER[role]) {
      throw new ForbiddenException(
        t('error.auth.roleRequired', {
          role: t(`role.${role}`),
          workspaceId,
          currentRole: t(`role.${member.role}`),
        }),
      );
    }
    if (operator && !member.trustedOperator) {
      throw new ForbiddenException(t('error.auth.trustedOperatorRequired'));
    }
  }

  /**
   * The narrowing a `kn_` key carries (docs/features/33). Exposed separately so
   * a caller with no workspace to resolve (the MCP tool filter) asks the same
   * question the guard does rather than a copy of it.
   */
  requireKeyAllows(key: NonNullable<Principal['apiKey']>, workspaceId: string, role: WorkspaceRole): void {
    if (key.workspaceId && key.workspaceId !== workspaceId) {
      throw new ForbiddenException(t('error.auth.apiKeyWorkspace', { workspaceId }));
    }
    if (key.scope === 'read' && ROLE_ORDER[role] > ROLE_ORDER.viewer) {
      throw new ForbiddenException(t('error.auth.apiKeyReadOnly', { role: t(`role.${role}`) }));
    }
  }

  /**
   * The principal a stored `created_by` stands for — how unattended work
   * (agent runs, workflow nodes) gets an identity to execute as.
   *
   * A disabled or deleted owner throws: background work never falls back to
   * ambient authority, and there is no service principal for it to become.
   * The one accommodation is the dev/MCP stub id, which has no `users` row by
   * design — the same allowance the merge gates make for that identity, and a
   * no-op under `api-key`, where no real user can hold it.
   *
   * It lives here rather than in each processor because both callers need the
   * exact same rule, and a second copy of it is a second place for the rule to
   * drift (docs/features/20).
   */
  async principalFor(userId: string, locale: Locale): Promise<Principal> {
    if (userId === DEV_PRINCIPAL.userId) return DEV_PRINCIPAL;
    const owner = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!owner || owner.disabledAt) {
      throw new ForbiddenException(t('error.auth.runOwnerUnavailable'));
    }
    return {
      userId: owner.id,
      email: owner.email,
      displayName: owner.displayName,
      avatarUrl: userAvatarUrl(owner),
      mode: 'api-key',
      isAdmin: owner.isAdmin,
      locale,
    };
  }

  /** For @Access(..., 'workspace') routes: 404 for unknown workspaces before the membership check. */
  async workspaceExists(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!ws) throw new NotFoundException(t('error.workspace.notFound', { id: workspaceId }));
    return ws.id;
  }

  async workspaceOfDocument(documentId: string): Promise<string> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    return doc.workspaceId;
  }

  async workspaceOfMergeRequest(mergeRequestId: string): Promise<string> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      select: { document: { select: { workspaceId: true } } },
    });
    if (!mr) throw new NotFoundException(t('error.mergeRequest.notFound', { id: mergeRequestId }));
    return mr.document.workspaceId;
  }

  /**
   * Saved merge-request filters are private to their owner, but the workspace
   * still gates them: the chips hold member ids and branch names that only
   * mean anything inside it. Ownership itself is checked in the service — the
   * guard resolves workspaces, not rows.
   */
  async workspaceOfSavedFilter(filterId: number): Promise<string> {
    const filter = await this.prisma.savedFilter.findUnique({
      where: { id: filterId },
      select: { workspaceId: true },
    });
    if (!filter) throw new NotFoundException(t('error.savedFilter.notFound', { id: filterId }));
    return filter.workspaceId;
  }

  async workspaceOfProject(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    return project.workspaceId;
  }

  /**
   * Assistant chat threads carry their own workspaceId, so resolving the ACL
   * from the `:id` param (rather than a caller-supplied `?workspaceId=`) is
   * what stops a viewer of workspace A from reading — or deleting — a thread
   * that belongs to workspace B.
   */
  async workspaceOfAssistantThread(threadId: string): Promise<string> {
    const thread = await this.prisma.assistantThread.findUnique({
      where: { id: threadId },
      select: { workspaceId: true },
    });
    if (!thread) throw new NotFoundException(t('error.assistant.threadNotFound', { id: threadId }));
    return thread.workspaceId;
  }

  /**
   * Skills and plugins shape what the assistant does for a whole workspace, so
   * resolving the ACL from the `:id` param — not a caller-supplied
   * `?workspaceId=` — is what stops an admin of workspace A from editing the
   * instructions or MCP credentials of workspace B.
   */
  async workspaceOfAiSkill(skillId: string): Promise<string> {
    const skill = await this.prisma.aiSkill.findUnique({
      where: { id: skillId },
      select: { workspaceId: true },
    });
    if (!skill) throw new NotFoundException(t('error.ai.skillNotFound', { id: skillId }));
    return skill.workspaceId;
  }

  async workspaceOfAiProvider(providerId: string): Promise<string> {
    const provider = await this.prisma.aiProvider.findUnique({
      where: { id: providerId },
      select: { workspaceId: true },
    });
    if (!provider) throw new NotFoundException(t('error.ai.providerNotFound', { id: providerId }));
    return provider.workspaceId;
  }

  async workspaceOfAiPlugin(pluginId: string): Promise<string> {
    const plugin = await this.prisma.aiPlugin.findUnique({
      where: { id: pluginId },
      select: { workspaceId: true },
    });
    if (!plugin) throw new NotFoundException(t('error.ai.pluginNotFound', { id: pluginId }));
    return plugin.workspaceId;
  }

  /**
   * The glossary is workspace vocabulary, so the ACL comes from the term's own
   * row rather than a caller-supplied `?workspaceId=` — otherwise an editor of
   * workspace A could rewrite the definitions workspace B's pages render.
   */
  async workspaceOfGlossaryTerm(termId: string): Promise<string> {
    const term = await this.prisma.glossaryTerm.findUnique({
      where: { id: termId },
      select: { workspaceId: true },
    });
    if (!term) throw new NotFoundException(t('error.glossary.notFound', { id: termId }));
    return term.workspaceId;
  }

  async workspaceOfSourcePolicy(policyId: string): Promise<string> {
    const policy = await this.prisma.sourcePolicy.findUnique({
      where: { id: policyId },
      select: { workspaceId: true },
    });
    if (!policy) throw new NotFoundException(t('error.web.notFound', { id: policyId }));
    return policy.workspaceId;
  }

  /**
   * An import job carries its own workspaceId and exists before any document
   * does, so this is the only thing standing between one tenant's import id and
   * another tenant's staged file.
   */
  async workspaceOfImport(importId: string): Promise<string> {
    const job = await this.prisma.importJob.findUnique({
      where: { id: importId },
      select: { workspaceId: true },
    });
    if (!job) throw new NotFoundException(t('error.import.notFound', { id: importId }));
    return job.workspaceId;
  }

  /**
   * A workflow definition shapes what the assistant writes into a workspace,
   * so — like AI skills and plugins — the ACL resolves from the `:id` param
   * rather than a caller-supplied `?workspaceId=`.
   */
  async workspaceOfWorkflowDefinition(definitionId: string): Promise<string> {
    const definition = await this.prisma.workflowDefinition.findUnique({
      where: { id: definitionId },
      select: { workspaceId: true },
    });
    if (!definition) throw new NotFoundException(t('error.workflow.notFound', { id: definitionId }));
    return definition.workspaceId;
  }

  async workspaceOfWorkflowRun(runId: string): Promise<string> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    });
    if (!run) throw new NotFoundException(t('error.workflow.runNotFound', { id: runId }));
    return run.workspaceId;
  }

  async workspaceOfJob(jobId: string): Promise<string> {
    const job = await this.prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { workspaceId: true },
    });
    if (!job) throw new NotFoundException(t('error.ingestionJob.notFound', { id: jobId }));
    return job.workspaceId;
  }

  async workspaceOfConnector(connectorId: string): Promise<string> {
    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      select: { workspaceId: true },
    });
    if (!connector) throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    return connector.workspaceId;
  }

  async workspaceOfConnectorRun(runId: string): Promise<string> {
    const run = await this.prisma.connectorRun.findUnique({
      where: { id: runId },
      select: { workspaceId: true },
    });
    if (!run) throw new NotFoundException(t('error.connector.runNotFound', { id: runId }));
    return run.workspaceId;
  }

  async memberships(principal: Principal) {
    if (principal.mode === 'dev') return [];
    return this.prisma.workspaceMember.findMany({ where: { userId: principal.userId } });
  }
}
