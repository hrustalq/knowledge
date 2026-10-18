import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { clientIp } from '../common/client-ip.js';
import { t } from '../i18n/t.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';

/**
 * Budgets for the anonymous auth routes (#75). Per IP always; per address too
 * where the body names one, so one IP cannot spread guesses across accounts
 * and many IPs cannot pile onto one.
 *
 * `failOpen` is the Redis-outage answer, chosen per route the way the share
 * unlock chose it: a password guess or an exchange code does not get unlimited
 * tries, but a domain lookup that only picks a login button stays up.
 */
const BUCKETS = {
  login: { perIp: 30, perEmail: 10, failOpen: false },
  discover: { perIp: 60, perEmail: null, failOpen: true },
  exchange: { perIp: 30, perEmail: null, failOpen: false },
  /** An LDAP password guess; "per email" is per typed username here. */
  ldap: { perIp: 30, perEmail: 10, failOpen: false },
} as const;
export type AuthRateBucket = keyof typeof BUCKETS;

const WINDOW_MS = 60_000;
const AUTH_RATE_META = 'knowledge:auth-rate';

/** Count the request against `bucket`'s budgets; 429 with Retry-After past either. */
export const AuthRateLimit = (bucket: AuthRateBucket) => SetMetadata(AUTH_RATE_META, bucket);

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(
    private readonly limiter: PublicRateLimiter,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const bucket = this.reflector.get<AuthRateBucket | undefined>(AUTH_RATE_META, ctx.getHandler());
    if (!bucket) return true;
    const budget = BUCKETS[bucket];
    const req = ctx.switchToHttp().getRequest();

    const checks = [this.limiter.hit(`auth:${bucket}:ip:${clientIp(req)}`, budget.perIp, WINDOW_MS, budget.failOpen)];
    const named = req.body?.email ?? req.body?.username;
    const email = typeof named === 'string' ? named.trim().toLowerCase().slice(0, 320) : '';
    if (budget.perEmail && email) {
      checks.push(this.limiter.hit(`auth:${bucket}:email:${email}`, budget.perEmail, WINDOW_MS, budget.failOpen));
    }
    if ((await Promise.all(checks)).every(Boolean)) return true;

    ctx.switchToHttp().getResponse().setHeader('Retry-After', String(WINDOW_MS / 1000));
    throw new RateLimitedException(t('error.auth.rateLimited'), WINDOW_MS / 1000, bucket);
  }
}
