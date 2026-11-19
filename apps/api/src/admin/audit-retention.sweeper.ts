import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Ticker } from '../common/ticker.js';

const TICK_MS = 60 * 60 * 1000;
const BATCH = 5000;
/** Batches per tick: a backlog drains over several hours rather than one long statement. */
const MAX_BATCHES = 20;

/**
 * Retention for audit_logs (#1251), in the API-only AdminModule so one kind of process sweeps. With AUDIT_RETENTION_DAYS
 * unset (0) it deletes nothing, ever; set, it deletes rows older than that once an hour, in batches.
 */
@Injectable()
export class AuditRetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetentionSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.days()) return;
    this.ticker.every(TICK_MS, () => this.sweep());
    void this.sweep();
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  private days(): number {
    return this.config.get('AUDIT_RETENTION_DAYS', { infer: true });
  }

  sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const days = this.days();
      if (!days) return;
      let removed = 0;
      // ponytail: no created_at-only index, so each batch scans; add one if audit_logs reaches millions of rows.
      for (let i = 0; i < MAX_BATCHES; i += 1) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM audit_logs WHERE id IN (
            SELECT id FROM audit_logs WHERE created_at < now() - make_interval(days => ${days}::int) LIMIT ${BATCH})`;
        removed += n;
        if (n < BATCH) break;
      }
      if (removed) this.logger.log(`Audit retention: ${removed} rows older than ${days} days deleted`);
    });
  }
}
