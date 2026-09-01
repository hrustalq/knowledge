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
