import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { apiKeyScopeOf, authMethodOf, keyToolsetsOf } from '@knowledge/contracts';
import { DEV_PRINCIPAL, type Principal } from './principal.js';
import { projectPinOf } from './api-keys.service.js';
import { SessionsService } from './sessions.service.js';
import { UrlTicketsService } from './url-tickets.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { hashToken } from './auth-tokens.js';
import { oauthEnabled, oauthUrls } from './oauth-urls.js';
import type { ApiKey, User } from '@prisma/client';

/** `ko_` access tokens of an OAuth grant (#1352); `kor_` refresh tokens are accepted only by the token endpoint. */
export const OAUTH_ACCESS_PREFIX = 'ko_';
export const OAUTH_REFRESH_PREFIX = 'kor_';

/**
 * Token → Principal resolution, shared by the HTTP AuthGuard and the live
 * WebSocket gateway (WS upgrade requests never pass through APP_GUARDs, so
 * the gateway authenticates connections itself with exactly the same rules).
 * AUTH_MODE=none → dev principal; api-key mode resolves `ks_` session tokens
 * and `kn_` API keys (SHA-256 lookups; disabled users refused on both paths).
 * A key that is revoked or past its expiry is indistinguishable from an
 * unknown one — the 401 does not confirm the key ever existed.
 */
@Injectable()
export class TokenAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly tickets: UrlTicketsService,
  ) {}

  /**
   * `mcp` is said only by the MCP endpoint's routes. A key limited to toolsets
   * (#945) is refused without it: its list is enforced by the MCP offer, so
   * anywhere else — a REST route, the git remote, the live socket, a
   * plain-markdown URL — the same key would read and write past it. Refused
   * here, where every door resolves its bearer, so a new door is closed to it
   * until it says otherwise.
   */
  async resolve(token: string | undefined, opts: { mcp?: boolean } = {}): Promise<Principal> {
    if (this.config.get('AUTH_MODE') !== 'api-key') return DEV_PRINCIPAL;
    if (!token) throw new UnauthorizedException(t('error.auth.missingBearer'));
    if (token.startsWith('ks_')) return this.resolveSession(token);
    const principal = token.startsWith(OAUTH_ACCESS_PREFIX) ? await this.resolveOAuth(token) : await this.resolveApiKey(token);
    // An OAuth token is MCP-only the same way (#1352): its audience is `/v1/mcp`.
    if ((principal.apiKey?.toolsets || principal.apiKey?.oauth) && !opts.mcp) {
      throw new ForbiddenException({
        statusCode: 403,
        message: t(principal.apiKey?.oauth ? 'error.auth.oauthMcpOnly' : 'error.auth.apiKeyMcpOnly'),
        reason: 'apiKeyMcpOnly',
      });
    }
    return principal;
  }

  /**
   * The `WWW-Authenticate` value a 401 from the MCP endpoint carries (#1352,
   * RFC 9728), or null while OAuth is off: it points the client at the
   * resource metadata, which names this API's authorization server.
   */
  mcpChallenge(): string | null {
    return oauthEnabled(this.config) ? `Bearer resource_metadata="${oauthUrls(this.config).resourceMetadata}"` : null;
  }

  /**
   * AUTH_REQUIRE_VERIFIED_EMAIL (docs/features/41): a login session whose
   * address is unproven may reach only the `@UnverifiedOk` routes. One
   * predicate, read by AuthGuard and the live gateway alike, so the socket is
   * not a way around the gate. API keys are minted by an admin and pass.
   */
  blocksUnverified(principal: Principal): boolean {
    return (
      principal.mode === 'session' &&
      principal.emailVerified === false &&
      this.config.get<boolean>('AUTH_REQUIRE_VERIFIED_EMAIL') === true
    );
  }

  /**
   * The browser's HttpOnly `kn_token` cookie (#650), read on any route that
   * got no header. The API only ever sets a `ks_` session there; anything else
   * is refused rather than resolved as an API key.
   */
  async resolveSessionCookie(token: string): Promise<Principal> {
    if (this.config.get('AUTH_MODE') !== 'api-key') return DEV_PRINCIPAL;
    if (!token.startsWith('ks_')) throw new UnauthorizedException(t('error.auth.invalidSession'));
    return this.resolveSession(token);
  }

  /**
   * A `kt_` ticket and nothing else: what `?token=` on a `@QueryTokenOk` route
   * and the `/v1/collab` socket accept (#102, #80). A URL outlives the request
   * that carried it (access logs, history, `Referer`), so a `ks_` session or a
   * `kn_` key there is refused: every client that holds one can send a header,
   * or mint a ticket with it first.
   */
  async resolveTicket(token: string | undefined): Promise<Principal> {
    if (this.config.get('AUTH_MODE') !== 'api-key') return DEV_PRINCIPAL;
    if (token && !UrlTicketsService.isTicket(token)) throw new UnauthorizedException(t('error.auth.credentialInUrl'));
    const principal = token ? await this.tickets.redeem(token) : null;
    if (!principal) throw new UnauthorizedException(t('error.auth.invalidUrlTicket'));
    return principal;
  }

  /**
   * Whether the credential a principal was resolved from still stands: the
   * account is enabled and its session or API key is neither revoked nor
   * expired. For a connection that outlives its ticket (#80), re-asked on an
   * interval — a principal is a snapshot of mint time.
   */
  async isCurrent(principal: Principal): Promise<boolean> {
    if (principal.mode === 'dev') return true;
    const now = new Date();
    const select = { revokedAt: true, expiresAt: true } as const;
    const live = (row: { revokedAt: Date | null; expiresAt: Date | null } | null) =>
      !!row && !row.revokedAt && !(row.expiresAt && row.expiresAt <= now);
    const [user, keyLive, sessionLive] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: principal.userId }, select: { disabledAt: true, isAdmin: true } }),
      principal.apiKey ? this.prisma.apiKey.findUnique({ where: { id: principal.apiKey.id }, select }).then(live) : true,
      principal.sessionId ? this.prisma.session.findUnique({ where: { id: principal.sessionId }, select }).then(live) : true,
    ]);
    // #1143: a principal minted while the person was a platform admin carries
    // that bypass for as long as it lives; once the flag is gone, it no longer stands.
    if (!user || user.disabledAt || (principal.isAdmin && !user.isAdmin)) return false;
    return keyLive && sessionLive;
  }

  private async resolveSession(token: string): Promise<Principal> {
    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException(t('error.auth.invalidSession'));
    if (session.user.disabledAt) throw new UnauthorizedException(t('error.auth.accountDisabled'));
    this.sessions.touch(session.id);
    return {
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      avatarUrl: userAvatarUrl(session.user),
      mode: 'session',
      isAdmin: session.user.isAdmin,
      locale: asLocale(session.user.locale),
      emailVerified: session.user.emailVerifiedAt !== null,
      sessionId: session.id,
      authMethod: authMethodOf(session.authMethod),
      sessionCreatedAt: session.createdAt.toISOString(),
      ...(session.providerId ? { providerId: session.providerId } : {}),
    };
  }

  private async resolveApiKey(key: string): Promise<Principal> {
    const row = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashToken(key) },
      include: { user: true },
    });
    const now = new Date();
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) {
      throw new UnauthorizedException(t('error.auth.unknownApiKey'));
    }
    return this.keyPrincipal(row, now);
  }

  private keyPrincipal(row: ApiKey & { user: User }, now: Date): Principal {
    const { user } = row;
    if (user.disabledAt) throw new UnauthorizedException(t('error.auth.accountDisabled'));
    this.touch(row.id, now);
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: userAvatarUrl(user),
      mode: 'api-key',
      isAdmin: user.isAdmin,
      locale: asLocale(user.locale),
      emailVerified: user.emailVerifiedAt !== null,
      apiKey: {
        id: row.id,
        scope: apiKeyScopeOf(row.scope),
        workspaceId: row.workspaceId,
        projectIds: projectPinOf(row.projectIds),
        toolsets: keyToolsetsOf(row.toolsets),
      },
    };
  }

  /**
   * A `ko_` access token (#1352): the grant row it points at is resolved
   * exactly like a key, so every narrowing, toolset and revocation rule a key
   * obeys applies unchanged. Off under MCP_OAUTH_ENABLED=false, where it reads
   * as an unknown key.
   */
  private async resolveOAuth(token: string): Promise<Principal> {
    const now = new Date();
    const row = oauthEnabled(this.config)
      ? await this.prisma.oAuthToken.findUnique({
          where: { tokenHash: hashToken(token) },
          include: { apiKey: { include: { user: true } } },
        })
      : null;
    const grant = row?.apiKey;
    if (!row || row.kind !== 'access' || row.expiresAt <= now || !grant?.oauthClientId || grant.revokedAt || (grant.expiresAt && grant.expiresAt <= now)) {
      throw new UnauthorizedException(t('error.auth.unknownApiKey'));
    }
    const principal = this.keyPrincipal(grant, now);
    principal.apiKey!.oauth = {
      clientId: grant.oauthClientId,
      signInMethod: grant.signInMethod ? authMethodOf(grant.signInMethod) : null,
      signInProviderId: grant.signInProviderId,
      grantedAt: grant.createdAt.toISOString(),
    };
    return principal;
  }

  /**
   * last_used_at, at most once a minute per key. An MCP client makes several
   * requests per tool call; writing on every one would turn reads into writes.
   * One guarded statement, fire-and-forget: bookkeeping never fails a request.
   */
  private touch(id: string, now: Date): void {
    const stale = new Date(now.getTime() - 60_000);
    void this.prisma.apiKey
      .updateMany({
        where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: stale } }] },
        data: { lastUsedAt: now },
      })
      .catch(() => undefined);
  }
}
