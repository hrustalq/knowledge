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
import type { AddMemberDto, UpdateMemberDto } from './workspaces.dto.js';

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
    const workspace = await this.prisma.workspace.create({ data: { name: name.trim() } });
    // The dev principal has no users row — membership would violate the FK.
    if (principal.mode !== 'dev') {
      await this.prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: principal.userId, role: 'admin', trustedOperator: true },
      });
    }
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
    if (!user) throw new NotFoundException('No user with that email — create the account first (signup or POST /v1/users)');
    await this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: { role: dto.role, trustedOperator: dto.trustedOperator ?? false },
      create: { workspaceId, userId: user.id, role: dto.role, trustedOperator: dto.trustedOperator ?? false },
    });
    return this.listMembers(workspaceId);
  }

  async updateMember(workspaceId: string, userId: string, dto: UpdateMemberDto): Promise<ListWorkspaceMembersResponse> {
    const member = await this.requireMember(workspaceId, userId);
    if (dto.role && dto.role !== 'admin' && member.role === 'admin') {
      await this.requireAnotherAdmin(workspaceId, userId, 'demote');
    }
    await this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: {
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.trustedOperator !== undefined ? { trustedOperator: dto.trustedOperator } : {}),
      },
    });
    return this.listMembers(workspaceId);
  }

  async removeMember(workspaceId: string, userId: string): Promise<ListWorkspaceMembersResponse> {
    const member = await this.requireMember(workspaceId, userId);
    if (member.role === 'admin') await this.requireAnotherAdmin(workspaceId, userId, 'remove');
    await this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    return this.listMembers(workspaceId);
  }

  private async requireMember(workspaceId: string, userId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) throw new NotFoundException(`User ${userId} is not a member of workspace ${workspaceId}`);
    return member;
  }

  /** Last-admin protection: a workspace must always keep at least one admin. */
  private async requireAnotherAdmin(workspaceId: string, exceptUserId: string, verb: string): Promise<void> {
    const otherAdmins = await this.prisma.workspaceMember.count({
      where: { workspaceId, role: 'admin', userId: { not: exceptUserId } },
    });
    if (otherAdmins === 0) {
      throw new BadRequestException(`Cannot ${verb} the last admin of the workspace`);
    }
  }
}
