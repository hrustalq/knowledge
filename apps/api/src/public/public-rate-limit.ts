import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PublicStore } from './public-store.js';

// Lifted to common/ when the auth flow started recording it (#75); re-exported
// so the publishing call sites keep their import.
import { clientIp } from '../common/client-ip.js';
export { clientIp };

export class RateLimitedException extends HttpException {
  /** `reason` tells limits apart for a client (flat extras, hoisted into `details`). */
  constructor(message: string, readonly retryAfterSec: number, reason?: string) {
    super(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, retryAfter: retryAfterSec, ...(reason ? { reason } : {}) },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Fixed-window counters in Redis (docs/features/43). In-house rather than
 * `@nestjs/throttler`: two INCRs a request need no dependency, and the same
 * counter serves the per-route budgets the later publishing phases add.
 */
@Injectable()
export class PublicRateLimiter {
  private readonly logger = new Logger(PublicRateLimiter.name);

  constructor(private readonly store: PublicStore) {}

  /**
   * Count one hit against `key` in a window of `windowMs`; true while the
   * count is within `limit`. `failOpen` decides what a Redis outage means:
   * reads stay up, a password guess does not get unlimited tries.
   */
  async hit(key: string, limit: number, windowMs: number, failOpen: boolean): Promise<boolean> {
    const bucket = `kn:rl:${key}:${Math.floor(Date.now() / windowMs)}`;
    try {
      const count = await this.store.kv.incr(bucket);
      if (count === 1) await this.store.kv.pexpire(bucket, windowMs);
      return count <= limit;
    } catch (err) {
      this.logger.warn({ msg: 'rate limiter unavailable', key, failOpen, err });
      return failOpen;
    }
  }
}

/** Per-IP cap across every anonymous read (PUBLIC_RATE_LIMIT_PER_MIN). */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  private readonly perMin: number;

  constructor(
    private readonly limiter: PublicRateLimiter,
    config: ConfigService<Env, true>,
  ) {
    this.perMin = config.get('PUBLIC_RATE_LIMIT_PER_MIN', { infer: true });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    if (await this.limiter.hit(`public:${clientIp(req)}`, this.perMin, 60_000, true)) return true;
    ctx.switchToHttp().getResponse().setHeader('Retry-After', '60');
    throw new RateLimitedException(t('error.share.rateLimited'), 60);
  }
}
