import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type UserGroup } from '@prisma/client';
import type {
  GroupSource,
  ListUserGroupMembersResponse,
  ListUserGroupsResponse,
  UserGroupSummary,
  WorkspaceRole,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { t } from '../i18n/t.js';
import type { CreateUserGroupDto, UpdateUserGroupDto, UpdateUserGroupMembersDto } from './permissions.dto.js';

type GroupWithCount = UserGroup & { _count: { members: number } };

/**
 * User groups (#76): the subjects page and project restrictions grant to.
 *
 * Roles are checked by AclGuard (`@Access('admin', …)` on every mutation);
 * this service holds what a guard cannot say — names are unique per
 * workspace, members must already belong to the workspace, and a group
 * mirrored from a source or provisioned by SCIM is never edited by hand,
 * because the next sync would silently undo the edit.
 */
@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(workspaceId: string): Promise<ListUserGroupsResponse> {
    const groups = await this.prisma.userGroup.findMany({
      where: { workspaceId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return { workspaceId, groups: groups.map(toSummary) };
  }

  async create(dto: CreateUserGroupDto): Promise<UserGroupSummary> {
    const name = dto.name.trim();
    const group = await this.uniqueName(name, () =>
      this.prisma.userGroup.create({
        data: { workspaceId: dto.workspaceId, name, description: blankToNull(dto.description) },
        include: { _count: { select: { members: true } } },
      }),
    );
    return toSummary(group);
  }

  async update(groupId: string, dto: UpdateUserGroupDto): Promise<UserGroupSummary> {
    await this.requireManual(groupId);
    const name = dto.name?.trim();
    const group = await this.uniqueName(name ?? '', () =>
      this.prisma.userGroup.update({
        where: { id: groupId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(dto.description !== undefined ? { description: blankToNull(dto.description) } : {}),
        },
        include: { _count: { select: { members: true } } },
      }),
    );
    return toSummary(group);
  }

  /**
   * Members go with it (FK cascade), and so do its grants (no FK, house
   * policy): a later group that reused the id must not inherit them.
   */
  async remove(groupId: string): Promise<{ deleted: true }> {
    await this.requireManual(groupId);
    await this.prisma.$transaction([
      this.prisma.accessGrant.deleteMany({ where: { subjectType: 'group', subjectId: groupId } }),
      this.prisma.userGroup.delete({ where: { id: groupId } }),
    ]);
    return { deleted: true };
  }

  async listMembers(groupId: string): Promise<ListUserGroupMembersResponse> {
    const group = await this.requireGroup(groupId);
    const rows = await this.prisma.userGroupMember.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
    });
    // No FK from user_group_members to users (house policy), so identity comes
    // from the workspace roster. A row whose person has left the workspace is
    // skipped rather than shown: removeMember deletes those, and a stray one
    // must not resurface a name to a roster that no longer includes it.
    const roster = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: group.workspaceId, userId: { in: rows.map((r) => r.userId) } },
      include: { user: true },
    });
    const byUser = new Map(roster.map((m) => [m.userId, m]));
    return {
      groupId,
      members: rows.flatMap((row) => {
        const member = byUser.get(row.userId);
        if (!member) return [];
        return [
          {
            userId: row.userId,
            email: member.user.email,
            displayName: member.user.displayName,
            avatarUrl: userAvatarUrl(member.user),
            role: member.role as WorkspaceRole,
            source: row.source as GroupSource,
            createdAt: row.createdAt.toISOString(),
          },
        ];
      }),
    };
  }

  /**
   * Add and remove in one call, so the picker's "save" is one request and one
   * transaction. Adding someone already in the group is a no-op, and so is
   * removing someone who is not.
   */
  async updateMembers(groupId: string, dto: UpdateUserGroupMembersDto): Promise<ListUserGroupMembersResponse> {
    const group = await this.requireManual(groupId);
    const add = [...new Set(dto.add ?? [])];
    const remove = [...new Set(dto.remove ?? [])].filter((id) => !add.includes(id));
    if (add.length > 0) {
      const members = await this.prisma.workspaceMember.findMany({
        where: { workspaceId: group.workspaceId, userId: { in: add } },
        select: { userId: true },
      });
      const known = new Set(members.map((m) => m.userId));
      const unknown = add.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new BadRequestException(t('error.group.notMembers', { users: unknown.join(', ') }));
      }
    }
    await this.prisma.$transaction([
      this.prisma.userGroupMember.deleteMany({ where: { groupId, userId: { in: remove } } }),
      this.prisma.userGroupMember.createMany({
        data: add.map((userId) => ({ groupId, userId })),
        skipDuplicates: true,
      }),
    ]);
    return this.listMembers(groupId);
  }

  private async requireGroup(groupId: string): Promise<UserGroup> {
    const group = await this.prisma.userGroup.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException(t('error.group.notFound', { id: groupId }));
    return group;
  }

  /** 409 for a group the API does not own: ACL sync or SCIM would overwrite the edit. */
  private async requireManual(groupId: string): Promise<UserGroup> {
    const group = await this.requireGroup(groupId);
    if (group.source !== 'manual') {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.access.groupReadOnly', { name: group.name }),
        reason: 'group.readOnly',
        source: group.source,
      });
    }
    return group;
  }

  /** The unique index decides a name clash, so two concurrent creates end as one 409, not a 500. */
  private async uniqueName<T>(name: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException({
          statusCode: 409,
          message: t('error.group.nameTaken', { name }),
          reason: 'group.nameTaken',
        });
      }
      throw e;
    }
  }
}

function toSummary(group: GroupWithCount): UserGroupSummary {
  return {
    groupId: group.id,
    workspaceId: group.workspaceId,
    name: group.name,
    description: group.description,
    source: group.source as GroupSource,
    memberCount: group._count.members,
    createdAt: group.createdAt.toISOString(),
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
