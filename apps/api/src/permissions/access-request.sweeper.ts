import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AccessRequestsService } from './access-requests.service.js';
import { Ticker } from '../common/ticker.js';

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
  private readonly ticker = new Ticker(this.logger);

  constructor(private readonly requests: AccessRequestsService) {}

  onModuleInit(): void {
    this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const expired = await this.requests.expireDue();
      if (expired > 0) this.logger.log(`expired ${expired} access requests`);
    });
  }
}
