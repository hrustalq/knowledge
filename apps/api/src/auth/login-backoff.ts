import { Injectable, Logger } from '@nestjs/common';
import { PublicStore } from '../public/public-store.js';

/**
 * Failed password logins slow down, never lock (#1092 leftover). The fixed
 * window (`AuthRateLimitGuard`, 10 a minute per address) lets a distributed
 * guesser try 14,400 passwords a day for one account, forever. Two counters of
 * consecutive failures add a wait on top:
 *
 * - **per address and IP**: from the 5th, 2 s doubling to 15 minutes. One
 *   source guessing is stopped fast, and the person signing in from anywhere
 *   else is not held by it.
 * - **per address**: from the 50th, 1 minute doubling to 15 minutes. Many
 *   sources slow down too. Holding someone out this way takes sustained
 *   guessing, and a hard lockout never happens: the wait is capped.
 *
 * A successful login or password reset clears the address. A Redis outage
 * waits nothing: the guard's window already fails closed for logins.
 */
export const PAIR_BACKOFF = { after: 5, baseSec: 2, capSec: 900 } as const;
export const ADDRESS_BACKOFF = { after: 50, baseSec: 60, capSec: 900 } as const;
const KEEP_MS = 24 * 3_600_000;

/** The wait after `failures` consecutive failures under `rule`, in seconds. */
export function backoffSeconds(failures: number, rule: { after: number; baseSec: number; capSec: number }): number {
  if (failures < rule.after) return 0;
  return Math.min(rule.capSec, rule.baseSec * 2 ** Math.min(failures - rule.after, 30));
}

@Injectable()
export class LoginBackoff {
  private readonly logger = new Logger(LoginBackoff.name);

  constructor(private readonly store: PublicStore) {}

  /** Seconds this address may not try a password from this IP yet; 0 when it may. */
  async retryAfter(email: string, ip: string, now = Date.now()): Promise<number> {
    try {
      const [pair, address] = await Promise.all([this.read(pairKey(email, ip)), this.read(addressKey(email))]);
      const left = (entry: Entry | null, rule: typeof PAIR_BACKOFF | typeof ADDRESS_BACKOFF) =>
        entry ? backoffSeconds(entry.count, rule) - (now - entry.at) / 1000 : 0;
      return Math.max(0, Math.ceil(Math.max(left(pair, PAIR_BACKOFF), left(address, ADDRESS_BACKOFF))));
    } catch (err) {
      this.logger.warn({ msg: 'login backoff unavailable', err });
      return 0;
    }
  }

  async failed(email: string, ip: string, now = Date.now()): Promise<void> {
    await Promise.all([this.bump(pairKey(email, ip), now), this.bump(addressKey(email), now)]).catch((err: unknown) =>
      this.logger.warn({ msg: 'login backoff not recorded', err }),
    );
  }

  /** The person got in, or proved the address another way (a reset): both counters start over. */
  async cleared(email: string, ip?: string): Promise<void> {
    await Promise.all([this.store.kv.del(addressKey(email)), ...(ip ? [this.store.kv.del(pairKey(email, ip))] : [])]).catch((err: unknown) =>
      this.logger.warn({ msg: 'login backoff not cleared', err }),
    );
  }

  private async read(key: string): Promise<Entry | null> {
    const raw = await this.store.kv.get(key);
    const [count, at] = (raw ?? '').split(':').map(Number);
    return raw && Number.isFinite(count) && Number.isFinite(at) ? { count: count!, at: at! } : null;
  }

  private async bump(key: string, now: number): Promise<void> {
    const count = ((await this.read(key))?.count ?? 0) + 1;
    await this.store.kv.set(key, `${count}:${now}`, 'PX', KEEP_MS);
  }
}

type Entry = { count: number; at: number };
const addressKey = (email: string) => `kn:lb:a:${email}`;
const pairKey = (email: string, ip: string) => `kn:lb:p:${email}:${ip}`;
