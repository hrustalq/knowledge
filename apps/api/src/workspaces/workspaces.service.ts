import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateWorkspaceResponse,
  ListWorkspaceCandidatesResponse,
  ListWorkspaceMembersResponse,
  ListWorkspacesResponse,
  WorkspaceRole,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import type { AddMemberDto, UpdateMemberDto } from './workspaces.dto.js';
import { t } from '../i18n/t.js';

/**
 * Access-control management: workspaces + workspace_members CRUD. Role checks
 * happen in AclGuard (@Access('admin', 'workspace') on mutating routes); this
 * service adds the invariants ACLs cannot express (last-admin protection).
 */
@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(principal: Principal): Promise<ListWorkspacesResponse> {
    const seesAll = principal.mode === 'dev' || principal.isAdmin;
    const memberships = await this.prisma.workspaceMember.findMany({ where: { userId: principal.userId } });
    const roleByWorkspace = new Map(memberships.map((m) => [m.workspaceId, m.role as WorkspaceRole]));

    const workspaces = await this.prisma.workspace.findMany({
      where: seesAll ? {} : { id: { in: [...roleByWorkspace.keys()] } },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return {
      workspaces: workspaces.map((w) => ({
        workspaceId: w.id,
        name: w.name,
        createdAt: w.createdAt.toISOString(),
        memberCount: w._count.members,
        myRole: roleByWorkspace.get(w.id) ?? null,
      })),
    };
  }

  async create(principal: Principal, name: string): Promise<CreateWorkspaceResponse> {
    // One transaction: a workspace whose founding admin never committed is
    // invisible to its creator (list scopes to membership), un-joinable (adding a
    // member is admin-gated) and undeletable (there is no delete route) — an
    // orphan row nobody can reach.
    const workspace = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: name.trim() } });
      // The dev principal has no users row — membership would violate the FK.
      if (principal.mode !== 'dev') {
        await tx.workspaceMember.create({
          data: { workspaceId: created.id, userId: principal.userId, role: 'admin', trustedOperator: true },
        });
      }
      return created;
    });
    return { workspaceId: workspace.id, name: workspace.name };
  }

  async listMembers(workspaceId: string): Promise<ListWorkspaceMembersResponse> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
      include: { user: true },
    });
    return {
      workspaceId,
      members: members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        displayName: m.user.displayName,
        avatarUrl: userAvatarUrl(m.user),
        role: m.role as WorkspaceRole,
        trustedOperator: m.trustedOperator,
        disabled: m.user.disabledAt !== null,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Users who could still be added to the workspace (existing members filtered
   * out). This is the only account lookup a workspace admin gets — it is
   * capped, projects identity fields only, and exists because `addMember`
   * takes an email of an *existing* account, which the picker has to find.
   */
  async listCandidates(
    workspaceId: string,
    query: string | undefined,
    limit: number,
  ): Promise<ListWorkspaceCandidatesResponse> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });
    const needle = query?.trim();
    const users = await this.prisma.user.findMany({
      where: {
        id: { notIn: members.map((m) => m.userId) },
        ...(needle
          ? {
              OR: [
                { email: { contains: needle, mode: 'insensitive' as const } },
                { displayName: { contains: needle, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { displayName: 'asc' },
      take: limit,
    });
    return {
      workspaceId,
      candidates: users.map((u) => ({
        userId: u.id,
        email: u.email,
        displayName: u.displayName,
        disabled: u.disabledAt !== null,
      })),
    };
  }

  async addMember(workspaceId: string, dto: AddMemberDto): Promise<ListWorkspaceMembersResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.trim().toLowerCase() } });
    if (!user) throw new NotFoundException(t('error.workspace.noUserWithEmail'));
    await this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: { role: dto.role, trustedOperator: dto.trustedOperator ?? false },
      create: { workspaceId, userId: user.id, role: dto.role, trustedOperator: dto.trustedOperator ?? false },
    });
    return this.listMembers(workspaceId);
  }

  async updateMember(workspaceId: string, userId: string, dto: UpdateMemberDto): Promise<ListWorkspaceMembersResponse> {
    const member = await this.requireMember(workspaceId, userId);
    const demotingAdmin = !!dto.role && dto.role !== 'admin' && member.role === 'admin';
    if (demotingAdmin) {
      // Guarded single statement rather than count-then-update: see removeMember.
      const affected = await this.prisma.$executeRaw`
        UPDATE workspace_members
           SET role = ${dto.role!}
         WHERE workspace_id = ${workspaceId}::uuid
           AND user_id = ${userId}::uuid
           AND EXISTS (
                 SELECT 1 FROM workspace_members other
                  WHERE other.workspace_id = ${workspaceId}::uuid
                    AND other.role = 'admin'
                    AND other.user_id <> ${userId}::uuid
               )
      `;
      if (affected === 0) throw new BadRequestException(t('error.workspace.lastAdminDemote'));
    }
    await this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: {
        // The role is already written above when this is a demotion; re-applying
        // the same value keeps one code path for trustedOperator.
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.trustedOperator !== undefined ? { trustedOperator: dto.trustedOperator } : {}),
      },
    });
    return this.listMembers(workspaceId);
  }

  async removeMember(workspaceId: string, userId: string): Promise<ListWorkspaceMembersResponse> {
    const member = await this.requireMember(workspaceId, userId);
    if (member.role !== 'admin') {
      await this.prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
      return this.listMembers(workspaceId);
    }
    // Last-admin protection has to be ONE statement. `count(other admins)` then
    // `delete` is check-then-act with nothing enforcing it: two concurrent
    // removals of the last two admins each counted one other admin and each
    // proceeded, leaving a workspace with zero admins — which no API route can
    // repair, since adding a member is itself admin-gated. The EXISTS subquery
    // is evaluated inside the same statement as the delete, so exactly one wins.
    // Raw SQL for the same reason AgentFindingsService.claim uses it: the query
    // API cannot express a predicate over a sibling row set.
    const affected = await this.prisma.$executeRaw`
      DELETE FROM workspace_members
       WHERE workspace_id = ${workspaceId}::uuid
         AND user_id = ${userId}::uuid
         AND EXISTS (
               SELECT 1 FROM workspace_members other
                WHERE other.workspace_id = ${workspaceId}::uuid
                  AND other.role = 'admin'
                  AND other.user_id <> ${userId}::uuid
             )
    `;
    if (affected === 0) throw new BadRequestException(t('error.workspace.lastAdminRemove'));
    return this.listMembers(workspaceId);
  }

  private async requireMember(workspaceId: string, userId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new NotFoundException(t('error.workspace.notAMember', { userId, workspaceId }));
    return member;
  }

}
