import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { apiKeyScopeOf, authMethodOf } from '@knowledge/contracts';
import { DEV_PRINCIPAL, type Principal } from './principal.js';
import { projectPinOf } from './api-keys.service.js';
import { SessionsService } from './sessions.service.js';
import { UrlTicketsService } from './url-tickets.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';

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

  async resolve(token: string | undefined): Promise<Principal> {
    if (this.config.get('AUTH_MODE') !== 'api-key') return DEV_PRINCIPAL;
    if (!token) throw new UnauthorizedException(t('error.auth.missingBearer'));
    return token.startsWith('ks_') ? this.resolveSession(token) : this.resolveApiKey(token);
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
      this.prisma.user.findUnique({ where: { id: principal.userId }, select: { disabledAt: true } }),
      principal.apiKey ? this.prisma.apiKey.findUnique({ where: { id: principal.apiKey.id }, select }).then(live) : true,
      principal.sessionId ? this.prisma.session.findUnique({ where: { id: principal.sessionId }, select }).then(live) : true,
    ]);
    return !!user && !user.disabledAt && keyLive && sessionLive;
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
      where: { keyHash: createHash('sha256').update(key).digest('hex') },
      include: { user: true },
    });
    const now = new Date();
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) {
      throw new UnauthorizedException(t('error.auth.unknownApiKey'));
    }
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
      },
    };
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
