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

/**
 * Phase 5 authentication (plan.md §11). AUTH_MODE=none keeps the Phase 0-4
 * dev flow: every request gets the synthetic dev principal. AUTH_MODE=api-key
 * resolves `Authorization: Bearer <key>` against users.api_key_hash (SHA-256;
 * plaintext keys are never stored).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
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
    // SSE: EventSource cannot set headers — accept the key via ?token= (docs/features/04).
    const queryToken = typeof req.query?.token === 'string' && req.query.token ? req.query.token : undefined;
    const key = bearer ?? queryToken;
    if (!key) throw new UnauthorizedException('Missing Authorization: Bearer <api key>');

    const user = await this.prisma.user.findUnique({
      where: { apiKeyHash: createHash('sha256').update(key).digest('hex') },
    });
    if (!user) throw new UnauthorizedException('Unknown API key');

    req.principal = {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      mode: 'api-key',
    } satisfies Principal;
    return true;
  }
}
