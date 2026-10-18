import { BadRequestException, ConflictException, ForbiddenException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AuthPolicyFailure,
  WorkspaceAuthPolicyApplied,
  WorkspaceAuthPolicySettings,
  WorkspaceAuthPolicyView,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { AuditService } from './audit.service.js';
import type { Principal } from './principal.js';
import { breakGlassEmails } from './password-policy.js';
import { liveIdpKinds } from './sso/live-kinds.js';

/** How long a workspace's policy is trusted in-process. Writes in this process invalidate at once. */
const POLICY_TTL_MS = 30_000;
/** A platform admin crossing enforced SSO is audited once per credential and workspace in this window. */
const BYPASS_AUDIT_EVERY_MS = 3_600_000;

export interface EffectivePolicy extends WorkspaceAuthPolicyApplied {
  asked: WorkspaceAuthPolicySettings;
  /** Enabled providers whose sessions satisfy enforcement: the workspace's own and every platform-wide one. */
  providers: { id: string; name: string }[];
  updatedAt: Date | null;
}

/** A verified, enforced domain an address belongs to — and what its workspace allows past it. */
export interface EnforcedDomain {
  domain: string;
  workspaceId: string;
  providerId: string | null;
  allowPasswordForAdmins: boolean;
}

const NO_POLICY: WorkspaceAuthPolicySettings = {
  ssoEnforced: null,
  allowApiKeys: null,
  allowPasswordForAdmins: null,
  sessionMaxAgeHours: null,
};

/**
 * Why `principal` may not reach a workspace under `policy`, or null if it may
 * (#75 phase 4). Pure, so the matrix is testable without a database, and so
 * the policy PUT asks the same question of its own caller before saving.
 *
 * - Only a session or a `kn_` key is judged. A principal with neither is
 *   unattended work (an agent run, a workflow node, a chat turn) executing as
 *   its owner via `AccessService.principalFor`: it was started by someone the
 *   check already let in, and refusing it would stop every background run the
 *   moment SSO is enforced.
 * - A session satisfies enforcement only when one of `policy.providers` issued it.
 * - The age cap applies to sessions, enforced SSO or not.
 * - The platform-admin exemption is the caller's to apply, not this function's.
 */
export function policyFailure(principal: Principal, policy: WorkspaceAuthPolicyApplied & { providers: { id: string }[] }, now = Date.now()): AuthPolicyFailure | null {
  if (principal.mode === 'dev') return null;
  if (principal.apiKey) return policy.ssoEnforced && !policy.allowApiKeys ? 'api-key' : null;
  if (!principal.sessionId) return null;
  if (policy.ssoEnforced) {
    if (!principal.authMethod || principal.authMethod === 'password' || !principal.providerId) return 'password-session';
    if (!policy.providers.some((p) => p.id === principal.providerId)) return 'foreign-provider';
  }
  if (policy.sessionMaxAgeHours && principal.sessionCreatedAt) {
    const age = now - Date.parse(principal.sessionCreatedAt);
    if (age > policy.sessionMaxAgeHours * 3_600_000) return 'session-too-old';
  }
  return null;
}

/**
 * Workspace sign-in policy (#75 phase 4): enforced SSO, keys under it, the
 * admin password exception, a session age cap — and the verified domains that
 * refuse passwords outright.
 *
 * The policy is the sparse `workspace_settings` auth columns, clamped by the
 * instance: with AUTH_SSO_ENABLED off (or AUTH_MODE other than api-key) no
 * enforcement applies whatever a row says, because nobody could satisfy it —
 * an SSO route that 404s cannot issue the session enforcement asks for.
 *
 * Prisma and config only, so it sits in `AuthCoreModule` beside
 * `AccessService`: the worker's `requireRole` reads the same policy.
 */
@Injectable()
export class AuthPolicyService {
  private readonly cache = new Map<string, { at: number; value: EffectivePolicy }>();
  private readonly bypassAudited = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** AUTH_SSO_ENABLED under AUTH_MODE=api-key: the ceiling every enforcement sits under. */
  get ssoEnabled(): boolean {
    return this.config.get<boolean>('AUTH_SSO_ENABLED') === true && this.config.get<string>('AUTH_MODE') === 'api-key';
  }

  get sessionTtlHours(): number {
    return this.config.get<number>('AUTH_SESSION_TTL_HOURS') ?? 720;
  }

  async effective(workspaceId: string): Promise<EffectivePolicy> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < POLICY_TTL_MS) return hit.value;
    const value = await this.load(workspaceId);
    this.cache.set(workspaceId, { at: Date.now(), value });
    return value;
  }

  /** After a write. Other processes (the worker, a second API) catch up within POLICY_TTL_MS. */
  invalidate(workspaceId?: string): void {
    if (workspaceId) this.cache.delete(workspaceId);
    else this.cache.clear();
  }

  /**
   * The check `AccessService.requireRole` runs after a key's narrowing and
   * before the membership lookup — so REST, MCP and the live socket all meet
   * it. A platform admin passes as break-glass, audited.
   */
  async enforce(principal: Principal, workspaceId: string): Promise<void> {
    if (principal.mode === 'dev' || (!principal.apiKey && !principal.sessionId)) return;
    const policy = await this.effective(workspaceId);
    if (!policy.ssoEnforced && !policy.sessionMaxAgeHours) return;
    const failure = policyFailure(principal, policy);
    if (!failure) return;
    if (principal.isAdmin) {
      this.auditBypass(principal, workspaceId, failure);
      return;
    }
    throw this.refusal(workspaceId, failure, policy);
  }

  /**
   * The 403 a refused principal gets. `reason` is what the web branches on:
   * `ssoRequired` sends the browser to sign in through `providers`,
   * `reauthRequired` to sign in again however the workspace allows.
   */
  refusal(workspaceId: string, failure: AuthPolicyFailure, policy: EffectivePolicy): ForbiddenException {
    const providers = policy.providers.map((p) => ({ id: p.id, name: p.name }));
    if (failure === 'api-key') {
      return new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: t('error.auth.apiKeysBlocked', { workspaceId }),
        reason: 'apiKeysBlocked',
        workspaceId,
      });
    }
    if (failure === 'session-too-old') {
      return new ForbiddenException({
        statusCode: HttpStatus.FORBIDDEN,
        message: t('error.auth.sessionTooOld', { hours: policy.sessionMaxAgeHours ?? 0 }),
        reason: 'reauthRequired',
        workspaceId,
        providers: policy.ssoEnforced ? providers : [],
      });
    }
    return new ForbiddenException({
      statusCode: HttpStatus.FORBIDDEN,
      message: t('error.auth.ssoRequired', { workspaceId }),
      reason: 'ssoRequired',
      workspaceId,
      providers,
    });
  }

  /**
   * The verified + enforced domain `email` is on, or null. Password login,
   * signup and reset read it; so does discovery, which then says `enforced`.
   * Off entirely under the SSO ceiling, like the workspace policy.
   */
  async enforcedDomainFor(email: string): Promise<EnforcedDomain | null> {
    if (!this.ssoEnabled) return null;
    const normalized = email.trim().toLowerCase();
    const at = normalized.lastIndexOf('@');
    if (at < 0) return null;
    const row = await this.prisma.ssoDomain.findUnique({ where: { domain: normalized.slice(at + 1) } });
    if (!row?.enforced || !row.verifiedAt) return null;
    const settings = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId: row.workspaceId },
      select: { allowPasswordForAdmins: true },
    });
    return {
      domain: row.domain,
      workspaceId: row.workspaceId,
      providerId: row.providerId,
      allowPasswordForAdmins: settings?.allowPasswordForAdmins === true,
    };
  }

  /** AUTH_BREAK_GLASS_EMAILS passes an enforced domain too — the way back in when the IdP is down. */
  isBreakGlass(email: string): boolean {
    return breakGlassEmails(this.config).has(email.trim().toLowerCase());
  }

  /** Settings → Security → Policy: what was asked, what applies, and the ceilings between them. */
  async view(workspaceId: string): Promise<WorkspaceAuthPolicyView> {
    const policy = await this.load(workspaceId);
    return {
      workspaceId,
      asked: policy.asked,
      applied: {
        ssoEnforced: policy.ssoEnforced,
        allowApiKeys: policy.allowApiKeys,
        allowPasswordForAdmins: policy.allowPasswordForAdmins,
        sessionMaxAgeHours: policy.sessionMaxAgeHours,
      },
      ceilings: { ssoEnabled: this.ssoEnabled, sessionTtlHours: this.sessionTtlHours },
      providers: policy.ssoEnforced ? policy.providers : await this.providersFor(workspaceId),
      updatedAt: policy.updatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Replace the policy. Refused when it could only lock people out: enforced
   * SSO with SSO off on the instance or no provider to satisfy it, or a policy
   * the admin saving it would fail — enforcing SSO from a password session is
   * the classic way to shut yourself out. A platform admin passes that last
   * check, as they pass the policy itself.
   */
  async put(workspaceId: string, asked: WorkspaceAuthPolicySettings, principal: Principal): Promise<WorkspaceAuthPolicyView> {
    if (asked.ssoEnforced && !this.ssoEnabled) throw new BadRequestException(t('error.sso.disabled'));
    const applied = this.apply(asked);
    const providers = applied.ssoEnforced ? await this.providersFor(workspaceId) : [];
    if (applied.ssoEnforced && !providers.length) throw new BadRequestException(t('error.sso.policyNoProvider'));
    const failure = principal.isAdmin ? null : policyFailure(principal, { ...applied, providers });
    if (failure) {
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message: t('error.sso.policyLocksYouOut', { failure }),
        failure,
      });
    }
    const before = (await this.load(workspaceId)).asked;
    await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, ...asked, updatedBy: principal.userId },
      update: { ...asked, updatedBy: principal.userId },
    });
    this.invalidate(workspaceId);
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'sso.policy_updated',
      params: { before, after: asked },
      ok: true,
    });
    return this.view(workspaceId);
  }

  /** The clamp, separate from the read so the policy PUT can preview what it is about to save. */
  apply(asked: WorkspaceAuthPolicySettings): WorkspaceAuthPolicyApplied {
    const ttl = this.sessionTtlHours;
    return {
      ssoEnforced: this.ssoEnabled && asked.ssoEnforced === true,
      allowApiKeys: asked.allowApiKeys !== false,
      allowPasswordForAdmins: asked.allowPasswordForAdmins === true,
      sessionMaxAgeHours: asked.sessionMaxAgeHours && asked.sessionMaxAgeHours < ttl ? asked.sessionMaxAgeHours : null,
    };
  }

  /** Enabled, sign-in-capable providers a workspace's sessions may come from. */
  async providersFor(workspaceId: string): Promise<{ id: string; name: string }[]> {
    return this.prisma.identityProvider.findMany({
      where: { enabled: true, kind: { in: liveIdpKinds(this.config) }, OR: [{ workspaceId }, { platformWide: true }] },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true },
    });
  }

  private async load(workspaceId: string): Promise<EffectivePolicy> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { ssoEnforced: true, allowApiKeys: true, allowPasswordForAdmins: true, sessionMaxAgeHours: true, updatedAt: true },
    });
    const asked: WorkspaceAuthPolicySettings = row
      ? {
          ssoEnforced: row.ssoEnforced,
          allowApiKeys: row.allowApiKeys,
          allowPasswordForAdmins: row.allowPasswordForAdmins,
          sessionMaxAgeHours: row.sessionMaxAgeHours,
        }
      : NO_POLICY;
    const applied = this.apply(asked);
    // Only an enforced workspace needs its providers on the hot path.
    const providers = applied.ssoEnforced ? await this.providersFor(workspaceId) : [];
    return { ...applied, asked, providers, updatedAt: row?.updatedAt ?? null };
  }

  private auditBypass(principal: Principal, workspaceId: string, failure: AuthPolicyFailure): void {
    const key = `${principal.sessionId ?? principal.apiKey?.id ?? principal.userId}:${workspaceId}`;
    const now = Date.now();
    const last = this.bypassAudited.get(key);
    if (last && now - last < BYPASS_AUDIT_EVERY_MS) return;
    if (this.bypassAudited.size > 10_000) this.bypassAudited.clear();
    this.bypassAudited.set(key, now);
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'auth.sso_bypassed',
      params: {
        reason: failure,
        authMethod: principal.authMethod ?? null,
        ...(principal.apiKey ? { apiKeyId: principal.apiKey.id } : { sessionId: principal.sessionId }),
      },
      ok: true,
      target: principal.userId,
    });
  }
}
