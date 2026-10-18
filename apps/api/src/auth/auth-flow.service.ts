import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AuthMethod,
  AuthSessionResponse,
  ForgotPasswordResponse,
  ResendVerificationResponse,
} from '@knowledge/contracts';
import type { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { MailProducer } from '../mail/mail.producer.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Principal } from './principal.js';
import { SessionsService, type SessionMeta } from './sessions.service.js';
import { passwordAllowedFor } from './password-policy.js';
import { AuthPolicyService, type EnforcedDomain } from './auth-policy.service.js';
import { AuditService } from './audit.service.js';
import type { RequestMeta } from '../common/client-ip.js';
import { hashToken, mintToken } from './auth-tokens.js';
import { toMeResponse } from './me-response.js';
import { asLocale } from '../i18n/locale.js';
import { currentLocale, t } from '../i18n/t.js';

/** Floor between two verification mails to one person — a resend button is easy to hold down. */
const RESEND_COOLDOWN_MS = 60_000;

/** How a session is being opened, beyond who for: what the session and its audit row record. */
export interface IssueSessionOptions extends Pick<SessionMeta, 'providerId' | 'idpSessionId' | 'ttlHours'> {
  authMethod: AuthMethod;
  /** The workspace the sign-in belongs to — an SSO provider's. Null for a password sign-in. */
  workspaceId: string | null;
  via: 'login' | 'signup' | 'sso';
  /** A password got past an enforced domain (break-glass email or admin exception): said in the audit row. */
  breakGlass?: boolean;
}

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
    private readonly mail: MailProducer,
    private readonly audit: AuditService,
    private readonly policy: AuthPolicyService,
  ) {}

  /** `debugToken` outside production: a dev or e2e flow must not need an inbox. */
  private get echoTokens(): boolean {
    return this.config.get<string>('NODE_ENV') !== 'production';
  }

  async signup(email: string, displayName: string, password: string, meta?: RequestMeta): Promise<AuthSessionResponse> {
    if (!this.config.get<boolean>('AUTH_SIGNUP_ENABLED')) {
      throw new ForbiddenException(t('error.auth.signupDisabled'));
    }
    const normalized = email.trim().toLowerCase();
    // A signup is a password account: under an SSO-only ceiling it would be one nobody can use.
    if (!passwordAllowedFor(normalized, this.config)) throw new ForbiddenException(t('error.auth.passwordLoginDisabled'));
    // A verified, enforced domain signs up through its IdP (JIT), never with a password.
    const enforced = await this.passwordBlockedBy(normalized);
    if (enforced) throw this.domainRefusal(enforced);
    const existing = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (existing) throw new ConflictException(t('error.auth.emailTaken'));

    const user = await this.prisma.user.create({
      data: {
        email: normalized,
        displayName: displayName.trim(),
        passwordHash: await hashPassword(password),
        // The language the signup form was in, so the first mail can be read.
        locale: currentLocale(),
      },
    });
    await this.sendVerification(user);

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
    return this.issueSession(user, meta, { authMethod: 'password', workspaceId: null, via: 'signup' });
  }

  async login(email: string, password: string, meta?: RequestMeta): Promise<AuthSessionResponse> {
    const normalized = email.trim().toLowerCase();
    // The ceiling is instance-wide, so saying so reveals nothing about the account.
    if (!passwordAllowedFor(normalized, this.config)) {
      this.recordFailure(normalized, 'password-login-disabled', meta);
      throw new ForbiddenException(t('error.auth.passwordLoginDisabled'));
    }
    // A verified, enforced domain (#75 phase 4) is domain-wide too.
    const domain = await this.policy.enforcedDomainFor(normalized);
    const breakGlass = domain !== null || this.config.get<boolean>('AUTH_PASSWORD_LOGIN_ENABLED') === false;
    const enforced = domain && !this.policy.isBreakGlass(normalized) ? domain : null;
    // No admin exception on this domain: refused before any password is looked at.
    if (enforced && !enforced.allowPasswordForAdmins) {
      this.recordFailure(normalized, 'sso-required-for-domain', meta);
      throw this.domainRefusal(enforced);
    }
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    const reason = !user
      ? 'unknown-email'
      : !user.passwordHash
        ? 'no-password'
        : user.disabledAt
          ? 'disabled'
          : (await verifyPassword(password, user.passwordHash))
            ? null
            : 'wrong-password';
    // With the admin exception on, the refusal is the same 403 for a wrong
    // password, an unknown address and a non-admin — so the answer never says
    // which addresses belong to an admin. Only the right admin password passes.
    if (enforced && (reason || !user?.isAdmin)) {
      this.recordFailure(normalized, reason ? `sso-required-for-domain:${reason}` : 'sso-required-for-domain', meta, user?.id);
      throw this.domainRefusal(enforced);
    }
    // Uniform failure: never reveal whether the email, password, or account state is wrong.
    // The reason goes to the audit trail only, which a platform admin reads.
    if (reason || !user) {
      this.recordFailure(normalized, reason ?? 'unknown-email', meta, user?.id);
      throw new UnauthorizedException(t('error.auth.invalidCredentials'));
    }
    return this.issueSession(user, meta, {
      authMethod: 'password',
      workspaceId: domain?.workspaceId ?? null,
      via: 'login',
      // A password past an SSO-only ceiling or an enforced domain: someone used the way back in.
      ...(breakGlass ? { breakGlass: true } : {}),
    });
  }

  /**
   * The enforced domain that refuses `email` a password, or null (#75 phase 4).
   * AUTH_BREAK_GLASS_EMAILS passes; the admin exception is the caller's to
   * judge, because it needs the password first.
   */
  private async passwordBlockedBy(email: string): Promise<EnforcedDomain | null> {
    const enforced = await this.policy.enforcedDomainFor(email);
    return enforced && !this.policy.isBreakGlass(email) ? enforced : null;
  }

  /** Domain-wide, so it reveals nothing about the account; `providerId` is where to send the person. */
  private domainRefusal(enforced: EnforcedDomain): ForbiddenException {
    return new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      message: t('error.auth.ssoRequiredForDomain', { domain: enforced.domain }),
      reason: 'ssoRequiredForDomain',
      domain: enforced.domain,
      providerId: enforced.providerId,
    });
  }

  private recordFailure(email: string, error: string, meta: RequestMeta | undefined, target?: string): void {
    void this.audit.record({
      workspaceId: null,
      actor: 'anonymous',
      action: 'auth.login_failed',
      params: { method: 'password', email: email.slice(0, 320) },
      ok: false,
      error,
      ip: meta?.ip,
      target: target ?? null,
    });
  }

  async logout(principal: Principal, meta?: RequestMeta): Promise<void> {
    if (!principal.sessionId) return;
    await this.sessions.revoke(principal.sessionId);
    void this.audit.record({
      workspaceId: null,
      actor: principal.userId,
      action: 'auth.logout',
      params: { sessionId: principal.sessionId },
      ok: true,
      ip: meta?.ip,
      target: principal.userId,
    });
  }

  async forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    const normalized = email.trim().toLowerCase();
    // A reset link for a password that cannot be used would only be a way to mint one.
    if (!passwordAllowedFor(normalized, this.config)) return { ok: true };
    const enforced = await this.passwordBlockedBy(normalized);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user || user.disabledAt) return { ok: true }; // no account enumeration
    // An enforced domain mints no reset link, except for the admin its exception lets in.
    if (enforced && !(enforced.allowPasswordForAdmins && user.isAdmin)) return { ok: true };

    const { token, tokenHash } = mintToken('kr_');
    const ttlMin = this.config.get<number>('AUTH_RESET_TTL_MIN') ?? 30;
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, purpose: 'reset', expiresAt: new Date(Date.now() + ttlMin * 60_000) },
    });
    // Queued, never sent inline: the response takes the same time whether or
    // not the account exists. The link itself is not logged here — under
    // MAIL_TRANSPORT=log the worker prints the whole message, and under smtp a
    // reset link in a log file is a credential in a log file.
    await this.mail.enqueue({ template: 'password-reset', userId: user.id, token });
    this.logger.log(`Password reset requested for user ${user.id}`);
    return this.echoTokens ? { ok: true, debugToken: token } : { ok: true };
  }

  /**
   * Redeems a `kr_` token, whichever mail carried it: a reset the person asked
   * for, or an invite an admin sent (docs/features/41). Either way the link
   * arrived at the address, so following it also proves the address.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    const reset = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
      throw new BadRequestException(t('error.auth.invalidResetToken'));
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: now } }),
      this.prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: await hashPassword(password) } }),
      this.prisma.user.updateMany({ where: { id: reset.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } }),
    ]);
    await this.sessions.revokeAllForUser(reset.userId); // stolen-session hygiene
    // An invite sets a first password; there was no previous one to warn about.
    if (reset.purpose !== 'invite') await this.mail.enqueue({ template: 'password-changed', userId: reset.userId });
  }

  async changePassword(principal: Principal, currentPassword: string, newPassword: string): Promise<void> {
    if (principal.mode === 'dev') throw new BadRequestException(t('error.auth.noPasswordInDevMode'));
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    if (!user?.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new UnauthorizedException(t('error.auth.currentPasswordIncorrect'));
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
    await this.sessions.revokeAllForUser(user.id, principal.sessionId);
    await this.mail.enqueue({ template: 'password-changed', userId: user.id });
  }

  /**
   * Redeem a `kv_` link (docs/features/41). The token proves the address it
   * was sent to, so it verifies only while that is still the account's
   * address. One guarded update per row: a double click spends it once.
   */
  async verifyEmail(token: string): Promise<void> {
    const row = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    const now = new Date();
    if (!row || row.expiresAt < now || row.user.email !== row.email || row.user.disabledAt) {
      throw new BadRequestException(t('error.auth.invalidVerifyToken'));
    }
    const spent = await this.prisma.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    // Already used: fine if it already verified (the second tab of a double
    // click), refused otherwise.
    if (spent.count === 0 && !row.user.emailVerifiedAt) {
      throw new BadRequestException(t('error.auth.invalidVerifyToken'));
    }
    await this.prisma.user.updateMany({ where: { id: row.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
  }

  async resendVerification(principal: Principal): Promise<ResendVerificationResponse> {
    if (principal.mode === 'dev') throw new BadRequestException(t('error.auth.noVerifyInDevMode'));
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    if (!user) throw new UnauthorizedException(t('error.auth.invalidSession'));
    if (user.emailVerifiedAt) return { ok: true, alreadyVerified: true };

    const last = await this.prisma.emailVerificationToken.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: t('error.auth.verifyTooSoon') },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const token = await this.sendVerification(user);
    return this.echoTokens ? { ok: true, alreadyVerified: false, debugToken: token } : { ok: true, alreadyVerified: false };
  }

  private async sendVerification(user: User): Promise<string> {
    const { token, tokenHash } = mintToken('kv_');
    const hours = this.config.get<number>('AUTH_VERIFY_TTL_HOURS') ?? 48;
    await this.prisma.emailVerificationToken.create({
      data: { userId: user.id, email: user.email, tokenHash, expiresAt: new Date(Date.now() + hours * 3_600_000) },
    });
    await this.mail.enqueue({ template: 'verify-email', userId: user.id, token });
    return token;
  }

  /**
   * Session + MeResponse for every way of signing in — password, signup, SSO
   * (#75). A signup is its first sign-in, and audited as one. An SSO sign-in
   * is audited under its provider's workspace, so that workspace's admins see it.
   */
  async issueSession(user: User, meta: RequestMeta | undefined, opts: IssueSessionOptions): Promise<AuthSessionResponse> {
    const { token, session } = await this.sessions.create(user.id, {
      authMethod: opts.authMethod,
      ...(opts.providerId ? { providerId: opts.providerId } : {}),
      ...(opts.idpSessionId ? { idpSessionId: opts.idpSessionId } : {}),
      ...(opts.ttlHours ? { ttlHours: opts.ttlHours } : {}),
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });
    void this.audit.record({
      workspaceId: opts.workspaceId,
      actor: user.id,
      action: 'auth.login',
      params: {
        method: opts.authMethod,
        via: opts.via,
        sessionId: session.id,
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        ...(opts.breakGlass ? { breakGlass: true } : {}),
      },
      ok: true,
      ip: meta?.ip,
      target: user.id,
    });
    const memberships = await this.prisma.workspaceMember.findMany({ where: { userId: user.id } });
    const me = toMeResponse(
      {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        avatarUrl: userAvatarUrl(user),
        mode: 'session',
        isAdmin: user.isAdmin,
        locale: asLocale(user.locale),
        emailVerified: user.emailVerifiedAt !== null,
        sessionId: session.id,
        authMethod: opts.authMethod,
      },
      memberships,
      this.config.get<boolean>('AUTH_REQUIRE_VERIFIED_EMAIL') === true,
    );
    return { token, expiresAt: session.expiresAt.toISOString(), me };
  }
}
