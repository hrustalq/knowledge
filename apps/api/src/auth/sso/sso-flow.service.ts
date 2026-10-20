import { createHash, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type IdentityProvider } from '@prisma/client';
import * as client from 'openid-client';
import {
  authMethodOf,
  type AuthSessionResponse,
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
import { liveIdpKinds } from './live-kinds.js';
import type { ExternalIdentity } from './oidc-claims.js';
import { SamlService, type SamlExpected } from './saml.service.js';
import { identityFromSamlProfile, samlConfigOf } from './saml-profile.js';
import { LDAP_DEFAULT_GROUPS_ATTRIBUTE, LdapService } from './ldap.service.js';
import { identityFromLdapEntry, ldapConfigOf } from './ldap-profile.js';
import { LOGOUT_TOKEN_MAX_AGE_SEC } from './oidc.service.js';

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
    private readonly ldap: LdapService,
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
        kind: { in: liveIdpKinds(this.config) },
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
        kind: { in: liveIdpKinds(this.config) },
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

  /**
   * LDAP sign-in (#75 phase 7). No redirect leg: the web posts the typed
   * credentials here and gets the session back, so there is no transaction row
   * and no fragment code. Wrong username and wrong password are one answer;
   * so is a disabled account, as for a password login. Only an unreachable
   * directory and a sign-in the account may not make say more.
   */
  async ldapLogin(providerId: string, username: string, password: string, meta: RequestMeta): Promise<AuthSessionResponse> {
    const provider = liveIdpKinds(this.config).includes('ldap') ? await this.liveProvider(providerId, 'ldap') : null;
    if (!provider) throw new NotFoundException(t('error.sso.providerNotFound'));
    const who = username.trim().slice(0, 100);

    const result = await this.ldap.authenticate(provider, username, password);
    if (!result.ok) {
      const unavailable = result.failure === 'unavailable';
      this.fail(provider, unavailable ? 'provider-error' : 'failed', `${result.failure} (${who}): ${result.detail}`, DEFAULT_RETURN, meta);
      if (unavailable) throw new ServiceUnavailableException(t('error.sso.ldapUnavailable'));
      throw new UnauthorizedException(t('error.sso.ldapInvalidCredentials'));
    }
    const claims = identityFromLdapEntry(result.entry, ldapConfigOf(provider), provider.groupsClaim ?? LDAP_DEFAULT_GROUPS_ATTRIBUTE);
    if (!claims.ok) {
      this.fail(provider, claims.error, `${claims.reason} (${who})`, DEFAULT_RETURN, meta);
      throw this.ldapRefusal(claims.error);
    }
    const outcome = await this.login.resolve(provider, claims.identity);
    if (!outcome.ok) {
      this.fail(provider, outcome.error, `${outcome.reason} (${who})`, DEFAULT_RETURN, meta, outcome.userId);
      if (outcome.error === 'account-disabled') throw new UnauthorizedException(t('error.sso.ldapInvalidCredentials'));
      throw this.ldapRefusal(outcome.error);
    }
    return this.flow.issueSession(outcome.user, meta, {
      authMethod: 'ldap',
      providerId: provider.id,
      ttlHours: provider.sessionTtlHours,
      workspaceId: provider.workspaceId,
      via: 'sso',
    });
  }

  /** The person is who they said, but may not sign in here: the same categories /login?error= shows. */
  private ldapRefusal(error: SsoLoginError): ForbiddenException {
    return new ForbiddenException({ statusCode: HttpStatus.FORBIDDEN, message: t('error.sso.ldapRefused'), loginError: error });
  }

  /**
   * OIDC back-channel logout (#75 phase 7): the IdP ended a session and says
   * so server to server. A verified token revokes our sessions that IdP
   * session opened (`sid`), or every session of that person through this
   * provider (`sub` alone). Each token is spent once by its `jti`.
   *
   * Answers whether the token was accepted; a token that names no session we
   * hold is still accepted — the IdP did its part, and saying otherwise would
   * tell a caller which sessions exist.
   */
  async backchannelLogout(providerId: string, token: string, meta: RequestMeta): Promise<boolean> {
    const provider = await this.liveProvider(providerId, 'oidc');
    if (!provider || !token) return false;
    const refuse = (reason: string): false => {
      void this.audit.record({
        workspaceId: provider.workspaceId,
        actor: 'idp',
        action: 'auth.session_revoked',
        params: { via: 'backchannel', providerId: provider.id },
        ok: false,
        error: reason.slice(0, 500),
        ip: meta.ip,
      });
      return false;
    };

    let claims;
    try {
      claims = await this.oidc.logoutClaims(provider, token);
    } catch (e) {
      return refuse((e as Error).message);
    }
    if (claims.jti) {
      try {
        await this.prisma.ssoAuthRequest.create({
          data: {
            providerId: provider.id,
            stateHash: sha256(`logout-jti:${provider.id}:${claims.jti}`),
            returnTo: DEFAULT_RETURN,
            consumedAt: new Date(),
            // Past this the token is refused for its age anyway, then the sweeper purges the marker.
            expiresAt: new Date(Date.now() + (LOGOUT_TOKEN_MAX_AGE_SEC + 120) * 1000),
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return refuse('logout token replayed');
        throw e;
      }
    }

    const identity = claims.sub
      ? await this.prisma.userIdentity.findUnique({ where: { providerId_subject: { providerId: provider.id, subject: claims.sub } } })
      : null;
    // Never an unnarrowed revoke: a `sub` we have not linked, with no `sid`, ends nothing.
    const { count } =
      claims.sid || identity
        ? await this.prisma.session.updateMany({
            where: {
              providerId: provider.id,
              revokedAt: null,
              ...(claims.sid ? { idpSessionId: claims.sid } : {}),
              ...(identity ? { userId: identity.userId } : {}),
            },
            data: { revokedAt: new Date() },
          })
        : { count: 0 };
    void this.audit.record({
      workspaceId: provider.workspaceId,
      actor: 'idp',
      action: 'auth.session_revoked',
      params: { via: 'backchannel', providerId: provider.id, by: claims.sid ? 'sid' : 'sub', sessionsRevoked: count },
      ok: true,
      ip: meta.ip,
      target: identity?.userId ?? null,
    });
    return true;
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

  /**
   * Trade the fragment code for a session. Single-use: the guarded statement
   * clears the hash it matched. A refused code — unknown, expired or already
   * spent — is audited like any other failed sign-in (a replayed code is the
   * signal an admin looks for), and the 400 carries the `/login?error=`
   * category for the page to show. A spent code's hash is gone, so its row is
   * not found and the audit row names no provider.
   */
  async exchange(code: string, meta: RequestMeta): Promise<SsoExchangeResponse> {
    const hash = sha256(code);
    const row = await this.prisma.ssoAuthRequest.findUnique({ where: { exchangeCodeHash: hash }, include: { provider: true } });
    if (!row || !row.userId) throw this.exchangeRefused(row?.provider ?? null, 'exchange code unknown or already spent', meta);
    if (row.expiresAt < new Date()) throw this.exchangeRefused(row.provider, 'exchange code expired', meta, row.userId);
    const spent = await this.prisma.ssoAuthRequest.updateMany({
      where: { id: row.id, exchangeCodeHash: hash },
      data: { exchangeCodeHash: null },
    });
    if (spent.count === 0) throw this.exchangeRefused(row.provider, 'exchange code replayed', meta, row.userId);

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
    this.auditFailure(provider, error, reason, meta, userId);
    return this.loginUrl(error, back);
  }

  /** The `auth.login_failed` row every refused sign-in leaves: the real reason for the admin, the category for the browser. */
  private auditFailure(
    provider: IdentityProvider | null,
    error: SsoLoginError,
    reason: string,
    meta?: RequestMeta,
    userId?: string,
  ): void {
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
  }

  /** A refused exchange code: audited, and a JSON 400 (the page POSTs it) carrying the login-error category. */
  private exchangeRefused(provider: IdentityProvider | null, reason: string, meta: RequestMeta, userId?: string): BadRequestException {
    this.auditFailure(provider, 'exchange-invalid', reason, meta, userId);
    return new BadRequestException({
      statusCode: HttpStatus.BAD_REQUEST,
      message: t('error.sso.exchangeInvalid'),
      loginError: 'exchange-invalid' satisfies SsoLoginError,
    });
  }

  private loginUrl(error: SsoLoginError, back: string): string {
    const params = new URLSearchParams({ error });
    if (back !== DEFAULT_RETURN) params.set('redirect', back);
    return `${this.web}/login?${params.toString()}`;
  }
}
