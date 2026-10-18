import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { SsoDomainsService } from './sso-domains.service.js';

/** One tick does everything; pending domains are therefore rechecked every 15 minutes, as promised. */
const SWEEP_INTERVAL_MS = 15 * 60_000;

/**
 * SSO housekeeping (#75 phase 4), API-side: a fixed tick, never a second run
 * while one is in flight (the house rule — there is no cron here).
 *
 * - Rechecks pending domain claims against DNS for their first week, so an
 *   admin who publishes the TXT record need not come back to press Verify.
 * - Purges login transactions past their expiry, and expired sessions. Both
 *   are refused anyway once expired; this only keeps the tables small.
 *
 * Off unless SSO is on: with AUTH_SSO_ENABLED unset nothing writes these rows,
 * and the instance behaves exactly as before.
 */
@Injectable()
export class SsoMaintenanceSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SsoMaintenanceSweeper.name);
  private readonly on: boolean;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly domains: SsoDomainsService,
  ) {
    this.on = config.get('AUTH_SSO_ENABLED', { infer: true }) && config.get('AUTH_MODE', { infer: true }) === 'api-key';
  }

  onModuleInit(): void {
    if (!this.on) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return; // a slow DNS pass must not stack on itself
    this.running = true;
    try {
      const [requests, sessions] = await Promise.all([
        this.prisma.ssoAuthRequest.deleteMany({ where: { expiresAt: { lt: now } } }),
        this.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
      ]);
      const proved = await this.domains.recheckPending();
      if (requests.count || sessions.count || proved) {
        this.logger.log(`purged ${requests.count} login transactions, ${sessions.count} sessions; verified ${proved} domains`);
      }
    } catch (e) {
      this.logger.warn(`sso maintenance failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
