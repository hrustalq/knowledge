import { createHash } from 'node:crypto';
import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { scimEnabled } from './scim-enabled.js';
import { ScimError } from './scim-errors.js';
import type { ScimCaller } from './scim.service.js';

export const SCIM_TOKEN_PREFIX = 'kscim_';

export const hashScimToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** last_used_at is written at most this often per token; a sync cycle makes many requests. */
const TOUCH_EVERY_MS = 60_000;

/**
 * `Authorization: Bearer kscim_…` → the workspace that token provisions (#75).
 *
 * The routes are `@Public()` to the global guards: a SCIM token is never a
 * principal, so it cannot open any other route and no `requireRole` ever sees
 * it. Lookup is by SHA-256 (the plaintext is never stored), and a revoked
 * token is as unknown as a made-up one. Off, every SCIM route is a 404.
 */
@Injectable()
export class ScimTokenGuard implements CanActivate {
  private readonly on: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.on = scimEnabled(config);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.on) throw new ScimError(HttpStatus.NOT_FOUND, t('error.scim.disabled'));
    const req = ctx.switchToHttp().getRequest<Request & { scim?: ScimCaller }>();
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && /^bearer /i.test(header) ? header.slice(7).trim() : '';
    const row = bearer.startsWith(SCIM_TOKEN_PREFIX)
      ? await this.prisma.scimToken.findUnique({ where: { tokenHash: hashScimToken(bearer) } })
      : null;
    if (!row || row.revokedAt) throw new ScimError(HttpStatus.UNAUTHORIZED, t('error.scim.unauthorized'));

    const now = Date.now();
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
      void this.prisma.scimToken
        .updateMany({
          where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - TOUCH_EVERY_MS) } }] },
          data: { lastUsedAt: new Date(now) },
        })
        .catch(() => undefined);
    }
    req.scim = { workspaceId: row.workspaceId, tokenId: row.id };
    return true;
  }
}
