import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { ListUsersResponse, UserSummary, WorkspaceRole } from '@knowledge/contracts';
import type { Prisma, User, WorkspaceMember } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import type { Principal } from '../auth/principal.js';
import { SessionsService } from '../auth/sessions.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import type { CreateUserDto, UpdateUserDto } from './users.dto.js';
import { t } from '../i18n/t.js';

/** Users management (platform admin surface — AclGuard enforces @PlatformAdmin). */

/** One unrevoked key is enough to answer `hasApiKey` (docs/features/33). */
const ACTIVE_KEY = { where: { revokedAt: null }, select: { id: true }, take: 1 } as const;
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async list(): Promise<ListUsersResponse> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { memberships: true, apiKeys: ACTIVE_KEY },
    });
    return { users: users.map((u) => this.toSummary(u)) };
  }

  async create(dto: CreateUserDto): Promise<UserSummary> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException(t('error.auth.emailTaken'));
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName: dto.displayName.trim(),
        isAdmin: dto.isAdmin ?? false,
        passwordHash: dto.password ? await hashPassword(dto.password) : null,
      },
      include: { memberships: true, apiKeys: ACTIVE_KEY },
    });
    return this.toSummary(user);
  }

  async update(actor: Principal, userId: string, dto: UpdateUserDto): Promise<UserSummary> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(t('error.user.notFound', { id: userId }));

    // Lock-out protection: admins cannot disable or de-admin themselves.
    if (actor.userId === userId && dto.disabled === true) {
      throw new BadRequestException(t('error.user.cannotDisableSelf'));
    }
    if (actor.userId === userId && dto.isAdmin === false) {
      throw new BadRequestException(t('error.user.cannotRemoveOwnAdmin'));
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName.trim();
    if (dto.isAdmin !== undefined) data.isAdmin = dto.isAdmin;
    if (dto.disabled !== undefined) data.disabledAt = dto.disabled ? (user.disabledAt ?? new Date()) : null;
    if (dto.password !== undefined) data.passwordHash = await hashPassword(dto.password);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      include: { memberships: true, apiKeys: ACTIVE_KEY },
    });
    // Disabling or overriding the password invalidates existing logins.
    if (dto.disabled === true || dto.password !== undefined) {
      await this.sessions.revokeAllForUser(userId);
    }
    return this.toSummary(updated);
  }

  private toSummary(user: User & { memberships: WorkspaceMember[]; apiKeys: { id: string }[] }): UserSummary {
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: userAvatarUrl(user),
      isAdmin: user.isAdmin,
      disabled: user.disabledAt !== null,
      hasPassword: user.passwordHash !== null,
      hasApiKey: user.apiKeys.length > 0,
      createdAt: user.createdAt.toISOString(),
      memberships: user.memberships.map((m) => ({
        workspaceId: m.workspaceId,
        role: m.role as WorkspaceRole,
        trustedOperator: m.trustedOperator,
      })),
    };
  }
}
