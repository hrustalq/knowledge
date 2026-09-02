import { createHash } from 'node:crypto';
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service.js';
import { PUBLIC_META } from './access.decorator.js';
import { DEV_PRINCIPAL, type Principal } from './principal.js';
import { SessionsService } from './sessions.service.js';

/**
 * Phase 5 authentication (plan.md §11). AUTH_MODE=none keeps the Phase 0-4
 * dev flow: every request gets the synthetic dev principal. AUTH_MODE=api-key
 * resolves `Authorization: Bearer <token>` — `kn_` API keys against
 * users.api_key_hash, `ks_` login session tokens against sessions.token_hash
 * (SHA-256 both; plaintext credentials are never stored). Disabled users
 * (users.disabled_at) are refused on either path → 401. Authorization
 * failures are AclGuard's job → 403.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_META, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();

    if (this.config.get('AUTH_MODE') !== 'api-key') {
      req.principal = DEV_PRINCIPAL;
      return true;
    }

    const header: string | undefined = req.headers['authorization'];
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    // SSE: EventSource cannot set headers — accept the token via ?token= (docs/features/04).
    const queryToken = typeof req.query?.token === 'string' && req.query.token ? req.query.token : undefined;
    const key = bearer ?? queryToken;
    if (!key) throw new UnauthorizedException('Missing Authorization: Bearer <api key or session token>');

    req.principal = key.startsWith('ks_') ? await this.resolveSession(key) : await this.resolveApiKey(key);
    return true;
  }

  private async resolveSession(token: string): Promise<Principal> {
    const session = await this.sessions.resolve(token);
    if (!session) throw new UnauthorizedException('Invalid or expired session — log in again');
    if (session.user.disabledAt) throw new UnauthorizedException('Account is disabled');
    return {
      userId: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      mode: 'session',
      isAdmin: session.user.isAdmin,
      sessionId: session.id,
    };
  }

  private async resolveApiKey(key: string): Promise<Principal> {
    const user = await this.prisma.user.findUnique({
      where: { apiKeyHash: createHash('sha256').update(key).digest('hex') },
    });
    if (!user) throw new UnauthorizedException('Unknown API key');
    if (user.disabledAt) throw new UnauthorizedException('Account is disabled');
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      mode: 'api-key',
      isAdmin: user.isAdmin,
    };
  }
}
