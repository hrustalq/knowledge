import { isIP } from 'node:net';
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

/** IPv4 private, loopback, link-local and CGNAT ranges, and their IPv6 equivalents. */
function isInternal(address: string): boolean {
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

/**
 * The address a public request is counted against.
 *
 * Nothing reaches the API from the internet directly: Caddy proxies `/api/*`
 * and the web SSR calls it over the internal network, both from a private
 * address, both carrying the visitor in X-Forwarded-For (see Caddyfile and
 * apps/web/server.js). So the header is believed only when the peer is
 * internal, and then its first entry is the visitor. A peer on a public
 * address is counted as itself, whatever header it sends.
 */
export function clientIp(req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> }): string {
  const peer = req.socket?.remoteAddress ?? req.ip ?? 'unknown';
  const forwarded = req.headers['x-forwarded-for'];
  if (isInternal(peer) && typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0].trim();
    if (isIP(first)) return first;
  }
  return peer;
}

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
