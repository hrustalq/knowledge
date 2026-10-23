import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  memberCapabilitiesOf,
  membershipSourceOf,
  type MemberCapability,
  type CreateWorkspaceResponse,
  type ListWorkspaceCandidatesResponse,
  type ListWorkspaceMembersResponse,
  type ListWorkspacesResponse,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import type { AddMemberDto, UpdateMemberDto } from './workspaces.dto.js';
import { t } from '../i18n/t.js';
import { removeMemberGuarded, setRoleGuarded } from './membership-guards.js';

/**
 * Access-control management: workspaces + workspace_members CRUD. Role checks
 * happen in AclGuard (@Access('admin', 'workspace') on mutating routes); this
 * service adds the invariants ACLs cannot express: last-admin protection
 * (`membership-guards.ts`) and rows an identity provider manages (#75).
 */
@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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
        capabilities: memberCapabilitiesOf(m.capabilities),
        source: membershipSourceOf(m.source),
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

  async addMember(workspaceId: string, dto: AddMemberDto, actorId: string): Promise<ListWorkspaceMembersResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.trim().toLowerCase() } });
    if (!user) throw new NotFoundException(t('error.workspace.noUserWithEmail'));
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    // Re-adding a member is a role change, and gets the same guards: the last
    // admin is not demoted, and an IdP-managed row is not silently taken over.
    if (existing) {
      return this.updateMember(
        workspaceId,
        user.id,
        { role: dto.role, trustedOperator: dto.trustedOperator ?? false, capabilities: dto.capabilities },
        actorId,
      );
    }
    const capabilities = memberCapabilitiesOf(dto.capabilities);
    const created = await this.prisma.workspaceMember.createMany({
      data: [{ workspaceId, userId: user.id, role: dto.role, trustedOperator: dto.trustedOperator ?? false, capabilities }],
      skipDuplicates: true,
    });
    if (created.count === 1) this.recordCapabilities(workspaceId, user.id, actorId, [], capabilities);
    return this.listMembers(workspaceId);
  }

  async updateMember(
    workspaceId: string,
    userId: string,
    dto: UpdateMemberDto,
    actorId: string,
  ): Promise<ListWorkspaceMembersResponse> {
    const member = await this.requireMember(workspaceId, userId);
    const capabilitiesBefore = memberCapabilitiesOf(member.capabilities);
    // A row JIT, group sync or SCIM wrote is theirs (#75): a hand edit would be
    // undone at the next sign-in. Taking it over is an explicit act. Read
    // through membershipSourceOf, as the member list is: what shows as manual edits as manual.
    // Capabilities are the exception (#468): no IdP writes them, so editing
    // them alone fights nothing and needs no takeover.
    const source = membershipSourceOf(member.source);
    const touchesSynced = dto.role !== undefined || dto.trustedOperator !== undefined;
    if (source !== 'manual' && touchesSynced && !dto.convertToManual) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.workspace.managedByIdp', { source }),
        source,
      });
    }
    if (dto.role !== undefined && !(await setRoleGuarded(this.prisma, workspaceId, userId, dto.role))) {
      throw new BadRequestException(t('error.workspace.lastAdminDemote'));
    }
    await this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: {
        ...(dto.trustedOperator !== undefined ? { trustedOperator: dto.trustedOperator } : {}),
        ...(dto.capabilities !== undefined ? { capabilities: memberCapabilitiesOf(dto.capabilities) } : {}),
        ...(dto.convertToManual ? { source: 'manual' } : {}),
      },
    });
    if (dto.capabilities !== undefined) {
      this.recordCapabilities(workspaceId, userId, actorId, capabilitiesBefore, memberCapabilitiesOf(dto.capabilities));
    }
    return this.listMembers(workspaceId);
  }

  /** One audit row per capability change (#468), naming what was granted and revoked. A no-op writes nothing. */
  private recordCapabilities(
    workspaceId: string,
    userId: string,
    actor: string,
    before: MemberCapability[],
    after: MemberCapability[],
  ): void {
    const granted = after.filter((c) => !before.includes(c));
    const revoked = before.filter((c) => !after.includes(c));
    if (granted.length === 0 && revoked.length === 0) return;
    void this.audit.record({
      workspaceId,
      actor,
      action: 'member.capabilities_changed',
      params: { granted, revoked },
      target: userId,
      ok: true,
    });
  }

  /**
   * Removing an IdP-managed member is allowed: it is the one hand edit sync
   * cannot fight over, though the next sign-in through that IdP may add them
   * back if a mapping or the default role still says so.
   */
  async removeMember(workspaceId: string, userId: string): Promise<ListWorkspaceMembersResponse> {
    await this.requireMember(workspaceId, userId);
    if (!(await removeMemberGuarded(this.prisma, workspaceId, userId))) {
      throw new BadRequestException(t('error.workspace.lastAdminRemove'));
    }
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
