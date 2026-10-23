import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  memberCapabilitiesOf,
  membershipSourceOf,
  type ListSessionsResponse,
  type ListUsersResponse,
  type RevokeSessionsResponse,
  type UserSummary,
  type WorkspaceRole,
} from '@knowledge/contracts';
import type { Prisma, User, WorkspaceMember } from '@prisma/client';
import { hashPassword } from '../auth/password.js';
import type { Principal } from '../auth/principal.js';
import { SessionsService } from '../auth/sessions.service.js';
import { AuditService } from '../auth/audit.service.js';
import { mintToken } from '../auth/auth-tokens.js';
import { MailProducer } from '../mail/mail.producer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import type { CreateUserDto, UpdateUserDto } from './users.dto.js';
import { currentLocale, t } from '../i18n/t.js';

/** Users management (platform admin surface — AclGuard enforces @PlatformAdmin). */

/** One unrevoked key is enough to answer `hasApiKey` (docs/features/33). */
const ACTIVE_KEY = { where: { revokedAt: null }, select: { id: true }, take: 1 } as const;
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly mail: MailProducer,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ListUsersResponse> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      include: { memberships: true, apiKeys: ACTIVE_KEY },
    });
    return { users: users.map((u) => this.toSummary(u)) };
  }

  async create(actor: Principal, dto: CreateUserDto): Promise<UserSummary> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException(t('error.auth.emailTaken'));
    const user = await this.prisma.user.create({
      data: {
        email,
        displayName: dto.displayName.trim(),
        isAdmin: dto.isAdmin ?? false,
        passwordHash: dto.password ? await hashPassword(dto.password) : null,
        // The admin's language is the best guess at the team's; the person
        // can switch it after signing in.
        locale: currentLocale(),
      },
      include: { memberships: true, apiKeys: ACTIVE_KEY },
    });
    // No password: the only way in is a link, so mail one (docs/features/41).
    // A redeemed invite also proves the address, the way a reset does.
    if (!dto.password) {
      const { token, tokenHash } = mintToken('kr_');
      const hours = this.config.get<number>('AUTH_INVITE_TTL_HOURS') ?? 72;
      await this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash, purpose: 'invite', expiresAt: new Date(Date.now() + hours * 3_600_000) },
      });
      await this.mail.enqueue({
        template: 'invite',
        userId: user.id,
        token,
        inviter: actor.mode === 'dev' ? null : actor.displayName,
      });
    }
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
    if (dto.password !== undefined) await this.mail.enqueue({ template: 'password-changed', userId });
    return this.toSummary(updated);
  }

  async listSessions(userId: string, currentSessionId?: string): Promise<ListSessionsResponse> {
    await this.assertExists(userId);
    return { sessions: await this.sessions.listForUser(userId, currentSessionId) };
  }

  /** Sign a person out everywhere (#75) without disabling them; their API keys keep working. */
  async revokeSessions(actor: Principal, userId: string, ip: string | null): Promise<RevokeSessionsResponse> {
    await this.assertExists(userId);
    const revoked = await this.sessions.revokeAllForUser(userId);
    void this.audit.record({
      workspaceId: null,
      actor: actor.userId,
      action: 'auth.session_revoked',
      params: { by: 'admin', count: revoked },
      ok: true,
      ip,
      target: userId,
    });
    return { revoked };
  }

  /**
   * Sign one of a person's sessions out (#292). The revoke is guarded by the
   * user id in the same statement, so a session id that belongs to someone
   * else reads as unknown rather than revoking the wrong person.
   */
  async revokeSession(actor: Principal, userId: string, sessionId: string, ip: string | null): Promise<void> {
    if (!(await this.sessions.revokeOwn(userId, sessionId))) {
      throw new NotFoundException(t('error.auth.sessionNotFound'));
    }
    void this.audit.record({
      workspaceId: null,
      actor: actor.userId,
      action: 'auth.session_revoked',
      params: { sessionId, by: 'admin' },
      ok: true,
      ip,
      target: userId,
    });
  }

  private async assertExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException(t('error.user.notFound', { id: userId }));
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
      emailVerified: user.emailVerifiedAt !== null,
      hasApiKey: user.apiKeys.length > 0,
      createdAt: user.createdAt.toISOString(),
      memberships: user.memberships.map((m) => ({
        workspaceId: m.workspaceId,
        role: m.role as WorkspaceRole,
        trustedOperator: m.trustedOperator,
        capabilities: memberCapabilitiesOf(m.capabilities),
        source: membershipSourceOf(m.source),
      })),
    };
  }
}
