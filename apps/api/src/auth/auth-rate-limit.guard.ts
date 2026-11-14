import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { clientIp } from '../common/client-ip.js';
import { t } from '../i18n/t.js';
import { PublicRateLimiter, RateLimitedException } from '../public/public-rate-limit.js';

/**
 * Budgets for the auth routes (#75, #1092). Per IP always; per address too
 * where the body names one, so one IP cannot spread guesses across accounts
 * and many IPs cannot pile onto one; per signed-in account where the route
 * has one (a password guess through a stolen session or key).
 *
 * `failOpen` is the Redis-outage answer, chosen per route the way the share
 * unlock chose it: a password guess, a mail sent or a token redeemed does not
 * get unlimited tries, but a domain lookup that only picks a login button
 * stays up.
 */
type Budget = { perIp: number; perEmail: number | null; perUser?: number; failOpen: boolean };
const BUCKETS = {
  login: { perIp: 30, perEmail: 10, failOpen: false },
  discover: { perIp: 60, perEmail: null, failOpen: true },
  exchange: { perIp: 30, perEmail: null, failOpen: false },
  /** An LDAP password guess; "per email" is per typed username here. */
  ldap: { perIp: 30, perEmail: 10, failOpen: false },
  /** Each hit can insert a token row and queue a mail to the named address. */
  forgot: { perIp: 10, perEmail: 3, failOpen: false },
  /** One scrypt per request, and one verification mail. */
  signup: { perIp: 10, perEmail: 3, failOpen: false },
  /** A token guess; the body names no address. */
  reset: { perIp: 10, perEmail: null, failOpen: false },
  verify: { perIp: 20, perEmail: null, failOpen: false },
  /** change-password: the current password guessed by whoever holds the session. */
  password: { perIp: 30, perEmail: null, perUser: 5, failOpen: false },
} as const satisfies Record<string, Budget>;
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
    const budget: Budget = BUCKETS[bucket];
    const req = ctx.switchToHttp().getRequest();

    const checks = [this.limiter.hit(`auth:${bucket}:ip:${clientIp(req)}`, budget.perIp, WINDOW_MS, budget.failOpen)];
    const named = req.body?.email ?? req.body?.username;
    const email = typeof named === 'string' ? named.trim().toLowerCase().slice(0, 320) : '';
    if (budget.perEmail && email) {
      checks.push(this.limiter.hit(`auth:${bucket}:email:${email}`, budget.perEmail, WINDOW_MS, budget.failOpen));
    }
    // Global guards run first, so a signed-in route's principal is already here.
    const userId: unknown = req.principal?.userId;
    if (budget.perUser && typeof userId === 'string') {
      checks.push(this.limiter.hit(`auth:${bucket}:user:${userId}`, budget.perUser, WINDOW_MS, budget.failOpen));
    }
    if ((await Promise.all(checks)).every(Boolean)) return true;

    ctx.switchToHttp().getResponse().setHeader('Retry-After', String(WINDOW_MS / 1000));
    throw new RateLimitedException(t('error.auth.rateLimited'), WINDOW_MS / 1000, bucket);
  }
}
