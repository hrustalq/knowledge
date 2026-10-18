import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type IdentityProvider } from '@prisma/client';
import * as client from 'openid-client';
import {
  authMethodOf,
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
import { AuthPolicyService } from '../auth-policy.service.js';
import { OIDC_PRESETS, presetOf } from './oidc-presets.js';
import { OidcService } from './oidc.service.js';
import { SsoLoginService } from './sso-login.service.js';
import { LIVE_IDP_KINDS } from './live-kinds.js';
import type { ExternalIdentity } from './oidc-claims.js';
import { SamlService, type SamlExpected } from './saml.service.js';
import { identityFromSamlProfile, samlConfigOf } from './saml-profile.js';

/** The fragment code's lifetime: long enough for one page load, short enough to be useless later. */
const EXCHANGE_TTL_MS = 60_000;
/** Where a sign-in lands when it did not say, and where a bad `returnTo` collapses to. */
const DEFAULT_RETURN = '/documents';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);


const toLoginProvider = (p: IdentityProvider): SsoLoginProvider => ({
  id: p.id,
  name: p.name,
  kind: (IDP_KINDS as readonly string[]).includes(p.kind) ? (p.kind as IdpKind) : 'oidc',
  preset: presetOf(p.preset),
});

/**
 * The SSO login transaction (#75): start → IdP → callback → exchange. OIDC
 * comes back on a GET callback, SAML on a POST to the ACS; both end in the
 * same fragment code.
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
    private readonly policy: AuthPolicyService,
    private readonly saml: SamlService,
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
        kind: { in: LIVE_IDP_KINDS },
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
   *
   * An enforced domain (#75 phase 4) also offers its own provider (or its
   * workspace's), and takes the password away unless the address is
   * break-glass or the workspace keeps the admin exception — which cannot be
   * told apart from here without saying who is an admin, so the field stays.
   */
  async discover(email: string): Promise<SsoDiscoverResponse> {
    const normalized = email.trim().toLowerCase();
    const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
    const enforced = await this.policy.enforcedDomainFor(normalized);
    const rows = await this.prisma.identityProvider.findMany({
      where: {
        enabled: true,
        kind: { in: LIVE_IDP_KINDS },
        OR: [
          { allowedDomains: { has: domain } },
          ...(enforced
            ? [enforced.providerId ? { id: enforced.providerId } : { OR: [{ workspaceId: enforced.workspaceId }, { platformWide: true }] }]
            : []),
        ],
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const passwordPast = !enforced || this.policy.isBreakGlass(normalized) || enforced.allowPasswordForAdmins;
    return {
      method: rows.length ? 'sso' : 'password',
      providers: rows.map(toLoginProvider),
      passwordAllowed: passwordAllowedFor(normalized, this.config) && passwordPast,
      enforced: enforced !== null,
    };
  }

  /** Open a transaction and answer where to send the browser — the IdP, or back to /login on failure. */
  async start(providerId: string, returnTo: string | undefined): Promise<string> {
    const back = safeReturnTo(returnTo, DEFAULT_RETURN);
    const provider = await this.liveProvider(providerId, 'oidc');
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
    if (!provider || !provider.enabled || provider.kind !== 'oidc') {
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
    return this.signIn(provider, claims.identity, row.id, back, meta);
  }

  /** SAML, SP-initiated: record the AuthnRequest, then send the browser to the IdP with it. */
  async samlStart(providerId: string, returnTo: string | undefined): Promise<string> {
    const back = safeReturnTo(returnTo, DEFAULT_RETURN);
    const provider = await this.liveProvider(providerId, 'saml');
    if (!provider) return this.loginUrl('failed', back);

    const relayState = randomBytes(32).toString('base64url');
    try {
      const { url, requestId } = await this.saml.authorizationUrl(provider, relayState);
      await this.prisma.ssoAuthRequest.create({
        data: {
          providerId: provider.id,
          stateHash: sha256(relayState),
          samlRequestId: requestId,
          returnTo: back,
          expiresAt: new Date(Date.now() + this.stateTtlMs),
        },
      });
      return url;
    } catch (e) {
      this.logger.warn({ msg: 'saml start failed', providerId, err: (e as Error).message });
      return this.fail(provider, 'provider-error', (e as Error).message, back);
    }
  }

  /**
   * The IdP's POST to our ACS. `RelayState` names the transaction of an
   * SP-initiated sign-in, spent once like an OIDC `state`; without one, the
   * response is unsolicited and accepted only where the provider allows it.
   * Either way the assertion's ID is then spent too, so the same assertion
   * cannot come back as an unsolicited one with its `RelayState` stripped.
   */
  async samlAcs(providerId: string, body: Record<string, unknown>, meta: RequestMeta): Promise<string> {
    const samlResponse = typeof body.SAMLResponse === 'string' ? body.SAMLResponse : '';
    const relayState = typeof body.RelayState === 'string' ? body.RelayState : '';
    const provider = await this.samlProvider(providerId);
    const row = relayState
      ? await this.prisma.ssoAuthRequest.findUnique({ where: { stateHash: sha256(relayState) } })
      : null;
    const solicited = row !== null && row.providerId === providerId && row.samlRequestId !== null;
    const back = solicited ? row.returnTo : DEFAULT_RETURN;

    if (!provider || !provider.enabled) return this.fail(provider, 'failed', 'provider disabled', back, meta);
    let expected: SamlExpected | null = null;
    if (solicited) {
      if (row.consumedAt || row.expiresAt < new Date()) {
        return this.fail(provider, 'invalid-state', row.consumedAt ? 'state replayed' : 'state expired', back, meta);
      }
      const spent = await this.prisma.ssoAuthRequest.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
      if (spent.count === 0) return this.fail(provider, 'invalid-state', 'state replayed', back, meta);
      expected = { requestId: row.samlRequestId!, issuedAt: row.createdAt };
    } else if (!samlConfigOf(provider).allowIdpInitiated) {
      return this.fail(provider, 'invalid-state', row ? 'state foreign' : 'unsolicited response', back, meta);
    }
    if (!samlResponse) return this.fail(provider, 'provider-error', 'no SAMLResponse', back, meta);

    let assertion;
    try {
      assertion = await this.saml.validate(provider, samlResponse, expected);
    } catch (e) {
      const status = (e as Error).name === 'SamlStatusError';
      return this.fail(provider, status ? 'provider-error' : 'id-token-invalid', (e as Error).message, back, meta);
    }
    try {
      // The marker outlives every moment the assertion could still be accepted, then the sweeper purges it.
      await this.prisma.ssoAuthRequest.create({
        data: {
          providerId: provider.id,
          stateHash: sha256(`saml-assertion:${provider.id}:${assertion.assertionId}`),
          returnTo: back,
          consumedAt: new Date(),
          expiresAt: new Date(Date.now() + this.saml.assertionLifetimeMs),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.fail(provider, 'invalid-state', 'assertion replayed', back, meta);
      }
      throw e;
    }

    const { emailAttribute, nameAttribute } = samlConfigOf(provider);
    const claims = identityFromSamlProfile(assertion.profile, { emailAttribute, nameAttribute, groupsAttribute: provider.groupsClaim });
    if (!claims.ok) return this.fail(provider, claims.error, claims.reason, back, meta);
    return this.signIn(provider, claims.identity, solicited ? row.id : null, back, meta);
  }

  /** The SP metadata of a SAML provider, enabled or not — an admin needs it before switching it on. */
  async samlMetadata(providerId: string): Promise<string | null> {
    const provider = await this.samlProvider(providerId);
    return provider ? this.saml.metadata(provider) : null;
  }

  /** A SAML provider by id, enabled or not: the ACS audits a disabled one's refusals under its name. */
  private samlProvider(providerId: string): Promise<IdentityProvider | null> {
    return isUuid(providerId) ? this.prisma.identityProvider.findFirst({ where: { id: providerId, kind: 'saml' } }) : Promise.resolve(null);
  }

  /**
   * Who the provider said signed in → an account, and the fragment code the
   * web trades for its session. The code goes on the transaction row, or on a
   * fresh one for an unsolicited SAML response, which has none.
   */
  private async signIn(
    provider: IdentityProvider,
    identity: ExternalIdentity,
    rowId: string | null,
    back: string,
    meta: RequestMeta,
  ): Promise<string> {
    if (identity.notes.length) {
      this.logger.warn({ msg: 'sso sign-in notes', providerId: provider.id, notes: identity.notes });
    }
    const outcome = await this.login.resolve(provider, identity);
    if (!outcome.ok) return this.fail(provider, outcome.error, outcome.reason, back, meta, outcome.userId);

    const code = randomBytes(32).toString('base64url');
    const exchange = {
      exchangeCodeHash: sha256(code),
      userId: outcome.user.id,
      idpSessionId: identity.idpSessionId,
      expiresAt: new Date(Date.now() + EXCHANGE_TTL_MS),
    };
    if (rowId) await this.prisma.ssoAuthRequest.update({ where: { id: rowId }, data: exchange });
    else {
      await this.prisma.ssoAuthRequest.create({
        data: {
          providerId: provider.id,
          stateHash: sha256(randomBytes(32).toString('base64url')),
          returnTo: back,
          consumedAt: new Date(),
          ...exchange,
        },
      });
    }
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
      authMethod: authMethodOf(row.provider.kind),
      providerId: row.providerId,
      idpSessionId: row.idpSessionId,
      ttlHours: row.provider.sessionTtlHours,
      workspaceId: row.provider.workspaceId,
      via: 'sso',
    });
    return { ...session, returnTo: row.returnTo };
  }

  private async liveProvider(providerId: string, kind: IdpKind): Promise<IdentityProvider | null> {
    if (!isUuid(providerId)) return null;
    return this.prisma.identityProvider.findFirst({ where: { id: providerId, enabled: true, kind } });
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
      params: { method: authMethodOf(provider?.kind ?? 'oidc'), providerId: provider?.id ?? null, error },
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
