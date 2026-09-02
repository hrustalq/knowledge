import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AuthSessionResponse,
  ForgotPasswordResponse,
  MeResponse,
  WorkspaceRole,
} from '@knowledge/contracts';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Principal } from './principal.js';
import { SessionsService } from './sessions.service.js';

/**
 * Auth flow (login / signup / password restoration) layered on Phase 5 auth.
 * Session tokens (`ks_`) are resolved by AuthGuard next to API keys (`kn_`);
 * ACLs stay exactly where they were — workspace_members via AclGuard.
 */
@Injectable()
export class AuthFlowService {
  private readonly logger = new Logger(AuthFlowService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sessions: SessionsService,
  ) {}

  async signup(email: string, displayName: string, password: string): Promise<AuthSessionResponse> {
    if (!this.config.get<boolean>('AUTH_SIGNUP_ENABLED')) {
      throw new ForbiddenException('Self-service signup is disabled (AUTH_SIGNUP_ENABLED=false)');
    }
    const normalized = email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (existing) throw new ConflictException('An account with this email already exists');

    const user = await this.prisma.user.create({
      data: { email: normalized, displayName: displayName.trim(), passwordHash: await hashPassword(password) },
    });

    // Auto-join the default workspace (demo by default) so the app is usable
    // right after signup. Skipped silently when unset or not yet created.
    const workspaceId = this.config.get<string>('AUTH_DEFAULT_WORKSPACE_ID');
    if (workspaceId) {
      const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
      if (workspace) {
        await this.prisma.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId, userId: user.id } },
          update: {},
          create: { workspaceId, userId: user.id, role: this.config.get<string>('AUTH_DEFAULT_ROLE') ?? 'viewer' },
        });
      }
    }
    return this.openSession(user);
  }

  async login(email: string, password: string): Promise<AuthSessionResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    // Uniform failure: never reveal whether the email, password, or account state is wrong.
    if (!user?.passwordHash || user.disabledAt || !(await verifyPassword(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.openSession(user);
  }

  async logout(principal: Principal): Promise<void> {
    if (principal.sessionId) await this.sessions.revoke(principal.sessionId);
  }

  async forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.disabledAt) return { ok: true }; // no account enumeration

    const token = `kr_${randomBytes(32).toString('hex')}`;
    const ttlMin = this.config.get<number>('AUTH_RESET_TTL_MIN') ?? 30;
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + ttlMin * 60_000),
      },
    });

    // No mail provider yet: the reset link goes to the API log (operator hands
    // it to the user). Swap for a mailer without touching the token flow.
    const link = `${this.config.get<string>('WEB_BASE_URL')}/reset-password?token=${token}`;
    this.logger.warn(`Password reset requested for ${user.email} — link (valid ${ttlMin} min): ${link}`);

    const isDev = this.config.get<string>('NODE_ENV') !== 'production';
    return isDev ? { ok: true, debugToken: token } : { ok: true };
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const reset = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: createHash('sha256').update(token).digest('hex') },
    });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: await hashPassword(password) } }),
    ]);
    await this.sessions.revokeAllForUser(reset.userId); // stolen-session hygiene
  }

  async changePassword(principal: Principal, currentPassword: string, newPassword: string): Promise<void> {
    if (principal.mode === 'dev') throw new BadRequestException('No password to change in AUTH_MODE=none');
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    await this.sessions.revokeAllForUser(user.id, principal.sessionId);
  }

  /** Session + MeResponse for signup/login responses. */
  private async openSession(user: User): Promise<AuthSessionResponse> {
    const { token, session } = await this.sessions.create(user.id);
    const memberships = await this.prisma.workspaceMember.findMany({ where: { userId: user.id } });
    const me: MeResponse = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      mode: 'session',
      isAdmin: user.isAdmin,
      memberships: memberships.map((m) => ({
        workspaceId: m.workspaceId,
        role: m.role as WorkspaceRole,
        trustedOperator: m.trustedOperator,
      })),
    };
    return { token, expiresAt: session.expiresAt.toISOString(), me };
  }
}
