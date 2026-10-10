import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { DEV_PRINCIPAL, type Principal } from './principal.js';
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
   * A credential that arrived in `?token=` on a `@QueryTokenOk` route (#102).
   * A URL outlives the request that carried it (access logs, history,
   * `Referer`), so it may hold only what is cheap to leak:
   * - a `kt_` ticket: single-use, ~60 s, redeemed here and gone;
   * - a `ks_` session token, which the web still puts on `<img>` URLs until
   *   asset tickets land (phase 2b).
   * A `kn_` API key is refused: it lives until revoked, and every client that
   * holds one can send a header, or mint a ticket with it first.
   */
  async resolveQueryToken(token: string): Promise<Principal> {
    if (this.config.get('AUTH_MODE') !== 'api-key') return DEV_PRINCIPAL;
    if (UrlTicketsService.isTicket(token)) {
      const principal = await this.tickets.redeem(token);
      if (!principal) throw new UnauthorizedException(t('error.auth.invalidUrlTicket'));
      return principal;
    }
    if (token.startsWith('ks_')) return this.resolveSession(token);
    throw new UnauthorizedException(t('error.auth.apiKeyInUrl'));
  }

  private async resolveSession(token: string): Promise<Principal> {
    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException(t('error.auth.invalidSession'));
    if (session.user.disabledAt) throw new UnauthorizedException(t('error.auth.accountDisabled'));
    return {
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      avatarUrl: userAvatarUrl(session.user),
      mode: 'session',
      isAdmin: session.user.isAdmin,
      locale: asLocale(session.user.locale),
      sessionId: session.id,
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
      apiKey: { id: row.id, scope: row.scope === 'read' ? 'read' : 'write', workspaceId: row.workspaceId },
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
