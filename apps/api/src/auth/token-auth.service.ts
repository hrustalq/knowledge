import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { userAvatarUrl } from '../common/avatar-url.js';
import { DEV_PRINCIPAL, type Principal } from './principal.js';
import { SessionsService } from './sessions.service.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';

/**
 * Token → Principal resolution, shared by the HTTP AuthGuard and the live
 * WebSocket gateway (WS upgrade requests never pass through APP_GUARDs, so
 * the gateway authenticates connections itself with exactly the same rules).
 * AUTH_MODE=none → dev principal; api-key mode resolves `ks_` session tokens
 * and `kn_` API keys (SHA-256 lookups; disabled users refused on both paths).
 */
@Injectable()
export class TokenAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  async resolve(token: string | undefined): Promise<Principal> {
    if (this.config.get('AUTH_MODE') !== 'api-key') return DEV_PRINCIPAL;
    if (!token) throw new UnauthorizedException(t('error.auth.missingBearer'));
    return token.startsWith('ks_') ? this.resolveSession(token) : this.resolveApiKey(token);
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
    const user = await this.prisma.user.findUnique({
      where: { apiKeyHash: createHash('sha256').update(key).digest('hex') },
    });
    if (!user) throw new UnauthorizedException(t('error.auth.unknownApiKey'));
    if (user.disabledAt) throw new UnauthorizedException(t('error.auth.accountDisabled'));
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: userAvatarUrl(user),
      mode: 'api-key',
      isAdmin: user.isAdmin,
      locale: asLocale(user.locale),
    };
  }
}
