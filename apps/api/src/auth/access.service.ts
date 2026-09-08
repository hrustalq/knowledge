import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { WorkspaceRole } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { ROLE_ORDER, type Principal } from './principal.js';

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
    if (principal.mode === 'dev') return; // AUTH_MODE=none — full access
    if (principal.isAdmin) return; // platform admin — implicit admin + operator everywhere
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: principal.userId } },
    });
    if (!member) throw new ForbiddenException(`Not a member of workspace ${workspaceId}`);
    if ((ROLE_ORDER[member.role as WorkspaceRole] ?? -1) < ROLE_ORDER[role]) {
      throw new ForbiddenException(
        `Requires the ${role} role in workspace ${workspaceId} (current role: ${member.role})`,
      );
    }
    if (operator && !member.trustedOperator) {
      throw new ForbiddenException('Requires trusted-operator membership (plan.md §9 query_graph gate)');
    }
  }

  /** For @Access(..., 'workspace') routes: 404 for unknown workspaces before the membership check. */
  async workspaceExists(workspaceId: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
    if (!ws) throw new NotFoundException(`Workspace ${workspaceId} not found`);
    return ws.id;
  }

  async workspaceOfDocument(documentId: string): Promise<string> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    if (!doc) throw new NotFoundException(`Document ${documentId} not found`);
    return doc.workspaceId;
  }

  async workspaceOfMergeRequest(mergeRequestId: string): Promise<string> {
    const mr = await this.prisma.mergeRequest.findUnique({
      where: { id: mergeRequestId },
      select: { document: { select: { workspaceId: true } } },
    });
    if (!mr) throw new NotFoundException(`Merge request ${mergeRequestId} not found`);
    return mr.document.workspaceId;
  }

  async workspaceOfProject(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
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
    if (!thread) throw new NotFoundException(`Assistant thread ${threadId} not found`);
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
    if (!skill) throw new NotFoundException(`Skill ${skillId} not found`);
    return skill.workspaceId;
  }

  async workspaceOfAiProvider(providerId: string): Promise<string> {
    const provider = await this.prisma.aiProvider.findUnique({
      where: { id: providerId },
      select: { workspaceId: true },
    });
    if (!provider) throw new NotFoundException(`Provider ${providerId} not found`);
    return provider.workspaceId;
  }

  async workspaceOfAiPlugin(pluginId: string): Promise<string> {
    const plugin = await this.prisma.aiPlugin.findUnique({
      where: { id: pluginId },
      select: { workspaceId: true },
    });
    if (!plugin) throw new NotFoundException(`Plugin ${pluginId} not found`);
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
    if (!term) throw new NotFoundException(`Glossary term ${termId} not found`);
    return term.workspaceId;
  }

  async workspaceOfJob(jobId: string): Promise<string> {
    const job = await this.prisma.ingestionJob.findUnique({
      where: { id: jobId },
      select: { workspaceId: true },
    });
    if (!job) throw new NotFoundException(`Ingestion job ${jobId} not found`);
    return job.workspaceId;
  }

  async memberships(principal: Principal) {
    if (principal.mode === 'dev') return [];
    return this.prisma.workspaceMember.findMany({ where: { userId: principal.userId } });
  }
}
