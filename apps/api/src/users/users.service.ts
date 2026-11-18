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
import type { AuditEntryInput } from '../auth/audit.service.js';
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
import type { Env } from '../config/env.js';

/** Users management (platform admin surface — AclGuard enforces @PlatformAdmin). */

/** One unrevoked key is enough to answer `hasApiKey` (docs/features/33). */
const ACTIVE_KEY = { where: { revokedAt: null }, select: { id: true }, take: 1 } as const;
/** What `toSummary` reads: a deleted workspace's memberships are left out (#1239). */
const SUMMARY_INCLUDE = {
  memberships: { where: { workspace: { deletedAt: null } }, include: { workspace: { select: { name: true } } } },
  apiKeys: ACTIVE_KEY,
} as const;
type SummaryRow = User & { memberships: (WorkspaceMember & { workspace: { name: string } })[]; apiKeys: { id: string }[] };
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly mail: MailProducer,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ListUsersResponse> {
    const [users, signIns] = await Promise.all([
      this.prisma.user.findMany({ orderBy: { createdAt: 'asc' }, include: SUMMARY_INCLUDE }),
      this.prisma.session.groupBy({ by: ['userId'], _max: { createdAt: true } }),
    ]);
    const last = new Map(signIns.map((r) => [r.userId, r._max.createdAt]));
    return { users: users.map((u) => this.toSummary(u, last.get(u.id) ?? null)) };
  }

  async create(actor: Principal, dto: CreateUserDto, ip: string | null = null): Promise<UserSummary> {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException(t('error.auth.emailTaken'));
    const passwordHash = dto.password ? await hashPassword(dto.password) : null;
    // The account and its invite link commit together (#816), as signup's do (#658):
    // an account with no password and no link is unreachable, and a retry 409s.
    const user = await this.prisma.withTransaction(async () => {
      const created = await this.prisma.user.create({
        data: {
          email,
          displayName: dto.displayName.trim(),
          isAdmin: dto.isAdmin ?? false,
          passwordHash,
          // The admin's language is the best guess at the team's; the person
          // can switch it after signing in.
          locale: currentLocale(),
        },
        include: SUMMARY_INCLUDE,
      });
      // No password: the only way in is a link, so mail one (docs/features/41).
      // A redeemed invite also proves the address, the way a reset does.
      if (!passwordHash) {
        const { token, tokenHash } = mintToken('kr_');
        const hours = this.config.get('AUTH_INVITE_TTL_HOURS', { infer: true });
        await this.prisma.passwordResetToken.create({
          data: { userId: created.id, tokenHash, purpose: 'invite', expiresAt: new Date(Date.now() + hours * 3_600_000) },
        });
        const inviter = actor.mode === 'dev' ? null : actor.displayName;
        this.prisma.onCommit(() => this.mail.enqueue({ template: 'invite', userId: created.id, token, inviter }));
      }
      return created;
    });
    void this.audit.record({
      workspaceId: null,
      actor: actor.userId,
      action: 'user.created',
      params: { isAdmin: user.isAdmin, invited: !passwordHash },
      ok: true,
      ip,
      target: user.id,
    });
    return this.toSummary(user, null);
  }

  async update(actor: Principal, userId: string, dto: UpdateUserDto, ip: string | null = null): Promise<UserSummary> {
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

    // Disabling or overriding the password invalidates existing logins, in the same commit (#656).
    const updated = await this.prisma.withTransaction(async () => {
      if (dto.disabled === true || dto.password !== undefined) {
        await this.sessions.revokeAllForUser(userId);
      }
      if (dto.password !== undefined) this.prisma.onCommit(() => this.mail.enqueue({ template: 'password-changed', userId }));
      return this.prisma.user.update({ where: { id: userId }, data, include: SUMMARY_INCLUDE });
    });
    for (const row of accountChanges(user, dto)) {
      void this.audit.record({ workspaceId: null, actor: actor.userId, ok: true, ip, target: userId, ...row });
    }
    // The newest session is the last sign-in (#1239); revoked or expired, it still happened.
    const last = await this.prisma.session.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    return this.toSummary(updated, last?.createdAt ?? null);
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

  private toSummary(user: SummaryRow, lastSignInAt: Date | null): UserSummary {
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
      lastSignInAt: lastSignInAt?.toISOString() ?? null,
      memberships: user.memberships.map((m) => ({
        workspaceId: m.workspaceId,
        workspaceName: m.workspace.name,
        role: m.role as WorkspaceRole,
        trustedOperator: m.trustedOperator,
        capabilities: memberCapabilitiesOf(m.capabilities),
        source: membershipSourceOf(m.source),
      })),
    };
  }
}

/**
 * The audit rows one account update writes (#1239): one per field whose value
 * changed, each with its own action so the audit filter finds it. A password
 * is recorded as set, never with its value.
 */
export function accountChanges(before: User, dto: UpdateUserDto): Pick<AuditEntryInput, 'action' | 'params'>[] {
  const rows: Pick<AuditEntryInput, 'action' | 'params'>[] = [];
  const name = dto.displayName?.trim();
  if (name !== undefined && name !== before.displayName) {
    rows.push({ action: 'user.renamed', params: { from: before.displayName, to: name } });
  }
  if (dto.isAdmin === true && !before.isAdmin) rows.push({ action: 'user.admin_granted', params: {} });
  if (dto.isAdmin === false && before.isAdmin) rows.push({ action: 'user.admin_revoked', params: {} });
  if (dto.disabled === true && !before.disabledAt) rows.push({ action: 'user.disabled', params: {} });
  if (dto.disabled === false && before.disabledAt) rows.push({ action: 'user.enabled', params: {} });
  if (dto.password !== undefined) rows.push({ action: 'user.password_set', params: {} });
  return rows;
}
