import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityProvider } from '@prisma/client';
import * as client from 'openid-client';
import {
  IDP_KINDS,
  type IdpKind,
  type SsoDiscoverResponse,
  type SsoExchangeResponse,
  type SsoLoginError,
  type SsoLoginProvider,
  type SsoProvidersResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestMeta } from '../../common/client-ip.js';
import { safeReturnTo } from '../../common/safe-return-to.js';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';
import { AuditService } from '../audit.service.js';
import { AuthFlowService } from '../auth-flow.service.js';
import { passwordAllowedFor } from '../password-policy.js';
import { OIDC_PRESETS, presetOf } from './oidc-presets.js';
import { OidcService } from './oidc.service.js';
import { SsoLoginService } from './sso-login.service.js';

/** The fragment code's lifetime: long enough for one page load, short enough to be useless later. */
const EXCHANGE_TTL_MS = 60_000;
/** Where a sign-in lands when it did not say, and where a bad `returnTo` collapses to. */
const DEFAULT_RETURN = '/documents';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Kinds that can sign anyone in today. SAML and LDAP join with their phases. */
const LIVE_KINDS: IdpKind[] = ['oidc'];

const toLoginProvider = (p: IdentityProvider): SsoLoginProvider => ({
  id: p.id,
  name: p.name,
  kind: (IDP_KINDS as readonly string[]).includes(p.kind) ? (p.kind as IdpKind) : 'oidc',
  preset: presetOf(p.preset),
});

/**
 * The SSO login transaction (#75): start → IdP → callback → exchange.
 *
 * Everything that must not be forged lives server-side in `sso_auth_requests`:
 * the browser carries only an opaque `state` there and back, stored as its
 * hash, spent by one guarded statement — so a replayed or forged state, an
 * expired one, or one for another provider all fail the same way.
 *
 * The session token never appears in a URL. The callback hands the browser a
 * 60 s single-use code in the fragment (which no server log or `Referer`
 * carries), and the web trades it for the token in a POST body.
 */
@Injectable()
export class SsoFlowService {
  private readonly logger = new Logger(SsoFlowService.name);
  private readonly web: string;
  private readonly stateTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly oidc: OidcService,
    private readonly login: SsoLoginService,
    private readonly flow: AuthFlowService,
    private readonly audit: AuditService,
  ) {
    this.web = config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.stateTtlMs = config.get('AUTH_SSO_STATE_TTL_SEC', { infer: true }) * 1000;
  }

  /** The login page's buttons: this workspace's providers, and every platform-wide one. */
  async loginProviders(workspaceId?: string): Promise<SsoProvidersResponse> {
    const rows = await this.prisma.identityProvider.findMany({
      where: {
        enabled: true,
        showOnLogin: true,
        kind: { in: LIVE_KINDS },
        OR: [{ platformWide: true }, ...(workspaceId && isUuid(workspaceId) ? [{ workspaceId }] : [])],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      providers: rows.map(toLoginProvider),
      passwordLogin: this.config.get('AUTH_PASSWORD_LOGIN_ENABLED', { infer: true }),
    };
  }

  /**
   * Email-first sign-in: which providers assert this address's domain. Decided
   * on the domain alone, so the answer is the same for an address with an
   * account and one without — discovery enumerates nobody.
   */
  async discover(email: string): Promise<SsoDiscoverResponse> {
    const normalized = email.trim().toLowerCase();
    const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
    const rows = await this.prisma.identityProvider.findMany({
      where: { enabled: true, kind: { in: LIVE_KINDS }, allowedDomains: { has: domain } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      method: rows.length ? 'sso' : 'password',
      providers: rows.map(toLoginProvider),
      passwordAllowed: passwordAllowedFor(normalized, this.config),
    };
  }

  /** Open a transaction and answer where to send the browser — the IdP, or back to /login on failure. */
  async start(providerId: string, returnTo: string | undefined): Promise<string> {
    const back = safeReturnTo(returnTo, DEFAULT_RETURN);
    const provider = await this.liveProvider(providerId);
    if (!provider) return this.loginUrl('failed', back);

    const oauth2 = OIDC_PRESETS[presetOf(provider.preset)].oauth2;
    const checks = {
      state: client.randomState(),
      nonce: oauth2 ? null : client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
    };
    try {
      const url = await this.oidc.authorizationUrl(provider, checks);
      await this.prisma.ssoAuthRequest.create({
        data: {
          providerId: provider.id,
          stateHash: sha256(checks.state),
          nonce: checks.nonce,
          codeVerifier: checks.codeVerifier,
          returnTo: back,
          expiresAt: new Date(Date.now() + this.stateTtlMs),
        },
      });
      return url.href;
    } catch (e) {
      // The IdP is unreachable or its discovery document is wrong: an admin
      // reads why in the audit trail and the log; the person sees one line.
      this.logger.warn({ msg: 'sso start failed', providerId, err: (e as Error).message });
      return this.fail(provider, 'provider-error', (e as Error).message, back);
    }
  }

  /** The IdP's redirect back. Always answers a URL to redirect to, success or not. */
  async callback(providerId: string, query: URLSearchParams, meta: RequestMeta): Promise<string> {
    const state = query.get('state');
    const row = state && isUuid(providerId)
      ? await this.prisma.ssoAuthRequest.findUnique({ where: { stateHash: sha256(state) }, include: { provider: true } })
      : null;
    const provider = row?.provider ?? null;
    const back = row?.returnTo ?? DEFAULT_RETURN;

    if (!state || !row || row.providerId !== providerId || row.consumedAt || row.expiresAt < new Date()) {
      return this.fail(provider, 'invalid-state', !row ? 'unknown state' : row.consumedAt ? 'state replayed' : 'state expired or foreign', back, meta);
    }
    // Spent before anything else happens, by one guarded statement: a second
    // callback with the same state — a replay, a double submit — finds none.
    const spent = await this.prisma.ssoAuthRequest.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count === 0) return this.fail(provider, 'invalid-state', 'state replayed', back, meta);
    if (!provider || !provider.enabled || !LIVE_KINDS.includes(provider.kind as IdpKind)) {
      return this.fail(provider, 'failed', 'provider disabled', back, meta);
    }

    const idpError = query.get('error');
    if (idpError) {
      const detail = query.get('error_description')?.slice(0, 200);
      return this.fail(provider, 'provider-error', detail ? `${idpError}: ${detail}` : idpError, back, meta);
    }

    let claims;
    try {
      const callbackUrl = new URL(this.oidc.redirectUri(provider.id));
      callbackUrl.search = query.toString();
      claims = await this.oidc.complete(provider, callbackUrl, {
        state,
        nonce: row.nonce,
        codeVerifier: row.codeVerifier ?? '',
      });
    } catch (e) {
      return this.fail(provider, 'id-token-invalid', (e as Error).message, back, meta);
    }
    if (!claims.ok) return this.fail(provider, claims.error, claims.reason, back, meta);
    if (claims.identity.notes.length) {
      this.logger.warn({ msg: 'sso sign-in notes', providerId: provider.id, notes: claims.identity.notes });
    }

    const outcome = await this.login.resolve(provider, claims.identity);
    if (!outcome.ok) return this.fail(provider, outcome.error, outcome.reason, back, meta, outcome.userId);

    const code = randomBytes(32).toString('base64url');
    await this.prisma.ssoAuthRequest.update({
      where: { id: row.id },
      data: {
        exchangeCodeHash: sha256(code),
        userId: outcome.user.id,
        idpSessionId: claims.identity.idpSessionId,
        expiresAt: new Date(Date.now() + EXCHANGE_TTL_MS),
      },
    });
    return `${this.web}/auth/sso/complete#code=${encodeURIComponent(code)}`;
  }

  /** Trade the fragment code for a session. Single-use: the guarded statement clears the hash it matched. */
  async exchange(code: string, meta: RequestMeta): Promise<SsoExchangeResponse> {
    const hash = sha256(code);
    const row = await this.prisma.ssoAuthRequest.findUnique({ where: { exchangeCodeHash: hash }, include: { provider: true } });
    if (!row || !row.userId || row.expiresAt < new Date()) throw new BadRequestException(t('error.sso.exchangeInvalid'));
    const spent = await this.prisma.ssoAuthRequest.updateMany({
      where: { id: row.id, exchangeCodeHash: hash },
      data: { exchangeCodeHash: null },
    });
    if (spent.count === 0) throw new BadRequestException(t('error.sso.exchangeInvalid'));

    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user || user.disabledAt) throw new UnauthorizedException(t('error.auth.accountDisabled'));
    const session = await this.flow.issueSession(user, meta, {
      authMethod: 'oidc',
      providerId: row.providerId,
      idpSessionId: row.idpSessionId,
      ttlHours: row.provider.sessionTtlHours,
      workspaceId: row.provider.workspaceId,
      via: 'sso',
    });
    return { ...session, returnTo: row.returnTo };
  }

  private async liveProvider(providerId: string): Promise<IdentityProvider | null> {
    if (!isUuid(providerId)) return null;
    return this.prisma.identityProvider.findFirst({ where: { id: providerId, enabled: true, kind: { in: LIVE_KINDS } } });
  }

  /** Audit the failure with its real reason; send the browser back to /login with only the category. */
  private fail(
    provider: IdentityProvider | null,
    error: SsoLoginError,
    reason: string,
    back: string,
    meta?: RequestMeta,
    userId?: string,
  ): string {
    void this.audit.record({
      workspaceId: provider?.workspaceId ?? null,
      actor: 'anonymous',
      action: 'auth.login_failed',
      params: { method: 'oidc', providerId: provider?.id ?? null, error },
      ok: false,
      error: reason.slice(0, 500),
      ip: meta?.ip,
      target: userId ?? null,
    });
    return this.loginUrl(error, back);
  }

  private loginUrl(error: SsoLoginError, back: string): string {
    const params = new URLSearchParams({ error });
    if (back !== DEFAULT_RETURN) params.set('redirect', back);
    return `${this.web}/login?${params.toString()}`;
  }
}
