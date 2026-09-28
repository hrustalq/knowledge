import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import type { Principal } from './principal.js';

/** Where a ticket's principal lives until it is redeemed or expires. */
const KEY_PREFIX = 'kn:url-ticket:';

/** DI token for a substitute store (specs); production builds its own Redis client. */
export const URL_TICKET_STORE = Symbol('URL_TICKET_STORE');

/**
 * Minimal Redis surface the service needs, so a spec can hand it a fake.
 * `getdel` is what makes a ticket single-use: read and delete in one command.
 */
export interface TicketStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
}

/**
 * Short-lived, single-use `kt_` tickets for URLs that cannot carry a header
 * (#102, phase 2). A header-authenticated caller mints one with
 * `POST /v1/auth/url-ticket` and puts it in `?token=` on a `@QueryTokenOk`
 * route instead of its session token or API key, so a credential that lives
 * for weeks never lands in an access log, browser history or `Referer`.
 *
 * - Only the SHA-256 of the ticket is stored, the same rule as `ks_` / `kn_`.
 * - The value is the principal as it was resolved at mint time. The TTL
 *   (`AUTH_URL_TICKET_TTL_SEC`, default 60 s) is the window in which a revoked
 *   key or session could still open one stream: the stream then lives on, the
 *   same as a stream opened with the key itself.
 * - Redemption is `GETDEL`, so a second use is a 401 even under a race.
 */
@Injectable()
export class UrlTicketsService implements OnModuleDestroy {
  private readonly store: TicketStore & { disconnect?: () => void };
  private readonly ttlSec: number;

  constructor(
    config: ConfigService<Env, true>,
    @Optional() @Inject(URL_TICKET_STORE) store?: TicketStore,
  ) {
    this.ttlSec = config.get('AUTH_URL_TICKET_TTL_SEC', { infer: true }) ?? 60;
    this.store =
      store ??
      new Redis(config.get('REDIS_URL', { infer: true }), {
        // Opened by the first mint, not at boot: the OpenAPI generator and the
        // MCP entrypoint load AuthModule with no Redis running.
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
      });
  }

  static isTicket(token: string): boolean {
    return token.startsWith('kt_');
  }

  private key(ticket: string): string {
    return KEY_PREFIX + createHash('sha256').update(ticket).digest('hex');
  }

  async mint(principal: Principal): Promise<{ ticket: string; expiresAt: string }> {
    const ticket = `kt_${randomBytes(24).toString('hex')}`;
    await this.store.set(this.key(ticket), JSON.stringify(principal), 'EX', this.ttlSec);
    return { ticket, expiresAt: new Date(Date.now() + this.ttlSec * 1000).toISOString() };
  }

  /** The principal the ticket was minted for, or null if unknown, expired or already used. */
  async redeem(ticket: string): Promise<Principal | null> {
    const raw = await this.store.getdel(this.key(ticket));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Principal;
    } catch {
      return null;
    }
  }

  onModuleDestroy(): void {
    this.store.disconnect?.();
  }
}
