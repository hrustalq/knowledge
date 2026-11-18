import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Ticker } from '../common/ticker.js';

const TICK_MS = 60 * 60 * 1000;
const BATCH = 5000;
/** Batches per tick: a backlog drains over several hours rather than one long lock. */
const MAX_BATCHES = 20;

/**
 * Retention for ops_events (#1240), worker-only so one process sweeps. Once an
 * hour it deletes rows older than OPS_EVENTS_RETENTION_DAYS, in batches over
 * the created_at index.
 */
@Injectable()
export class OpsRetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpsRetentionSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.ticker.every(TICK_MS, () => this.sweep());
    void this.sweep();
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const days = this.config.get('OPS_EVENTS_RETENTION_DAYS', { infer: true });
      let removed = 0;
      for (let i = 0; i < MAX_BATCHES; i += 1) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM ops_events WHERE id IN (
            SELECT id FROM ops_events WHERE created_at < now() - make_interval(days => ${days}::int) LIMIT ${BATCH})`;
        removed += n;
        if (n < BATCH) break;
      }
      if (removed) this.logger.log(`Ops events retention: ${removed} rows deleted`);
    });
  }
}
