import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { CaptureInboxService } from './capture-inbox.service.js';
import { Ticker } from '../common/ticker.js';

/**
 * Finishes captures a crash stranded between stage and propose (issue #73):
 * the API died after inserting the `staged` row, or while holding its claim.
 *
 * API-side, because proposing opens a merge request attributed to the
 * capture's writer, and only the API has a principal ("the worker generates,
 * the API publishes"). A due check inside a fixed tick, never a second sweep
 * while one runs: the repo has no cron.
 */
@Injectable()
export class CaptureSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptureSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly inbox: CaptureInboxService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.ticker.every(this.config.get('CAPTURE_SWEEP_INTERVAL_MS', { infer: true }), () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const settled = await this.inbox.sweepStranded();
      if (settled > 0) this.logger.log(`settled ${settled} stranded captures`);
    });
  }
}
