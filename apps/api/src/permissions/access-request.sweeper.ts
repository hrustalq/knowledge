import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AccessRequestsService } from './access-requests.service.js';

/** A request lives for days; minutes of slack on when it lapses cost nothing. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Lapses pending access requests past ACCESS_REQUEST_TTL_DAYS (#76, phase 5)
 * and tells each requester.
 *
 * API-side, because it writes notifications attributed to nothing in
 * particular and needs no worker machinery — the shape of MentionReplySweeper.
 * A due check inside a fixed tick, never a second sweep while one runs: the
 * repo has no cron.
 */
@Injectable()
export class AccessRequestSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccessRequestSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly requests: AccessRequestsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const expired = await this.requests.expireDue();
      if (expired > 0) this.logger.log(`expired ${expired} access requests`);
    } catch (e: unknown) {
      this.logger.warn(`access request sweep failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
