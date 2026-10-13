import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

/** Files deleted per tick: each is an S3 round trip, and a tick must not outlast its interval. */
const EXPIRIES_PER_TICK = 50;
/** How often the sweep runs. An export lives for hours, so a minute of lateness is invisible. */
export const EXPORT_SWEEP_INTERVAL_MS = 60_000;

/**
 * The export due checks (docs/features/45), on one fixed tick with
 * back-pressure (CLAUDE.md: no cron in this repo):
 *
 * - **Expired files.** A completed export past `expires_at` has its object
 *   deleted and its row marked `expired`; the row stays, as the record of who
 *   exported what. The status flip is the claim, so two API processes never
 *   both count one file.
 * - **Lost jobs.** A row still `queued` or `running` long past
 *   EXPORT_TIMEOUT_MS lost its worker — a Redis flush, a worker that died
 *   mid-build. It is failed rather than requeued: an export is cheap to ask
 *   for again, and the person sees why it stopped.
 *
 * Its own sweeper rather than a third duty of PublishingSweeper: exports are
 * a member's download and share nothing with sites but the issue they came in.
 */
@Injectable()
export class ExportSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExportSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), EXPORT_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<{ expired: number; failed: number }> {
    if (this.running) return { expired: 0, failed: 0 };
    this.running = true;
    try {
      const expired = await this.expireFiles(now).catch((e: unknown) => {
        this.logger.warn(`export expiry sweep failed: ${String(e)}`);
        return 0;
      });
      const failed = await this.failLostJobs(now).catch((e: unknown) => {
        this.logger.warn(`lost-export sweep failed: ${String(e)}`);
        return 0;
      });
      if (failed > 0) this.logger.warn(`failed ${failed} exports that lost their worker`);
      return { expired, failed };
    } finally {
      this.running = false;
    }
  }

  private async expireFiles(now: Date): Promise<number> {
    const due = await this.prisma.exportJob.findMany({
      where: { status: 'completed', expiresAt: { lte: now } },
      select: { id: true, s3Key: true },
      take: EXPIRIES_PER_TICK,
    });
    let count = 0;
    for (const row of due) {
      const claimed = await this.prisma.exportJob.updateMany({
        where: { id: row.id, status: 'completed' },
        data: { status: 'expired' },
      });
      if (claimed.count === 0) continue;
      count++;
      // The bucket is versioned: a plain delete would leave the bytes behind
      // a delete marker, which is not what "the file is gone" promises.
      if (row.s3Key) await this.storage.purgeObjectVersions(row.s3Key).catch((e: unknown) => {
        this.logger.warn(`export ${row.id}: could not delete ${row.s3Key}: ${String(e)}`);
      });
    }
    return count;
  }

  private async failLostJobs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 2 * this.config.get('EXPORT_TIMEOUT_MS', { infer: true }));
    const res = await this.prisma.exportJob.updateMany({
      where: { status: { in: ['queued', 'running'] }, createdAt: { lt: cutoff } },
      data: {
        status: 'failed',
        stage: null,
        completedAt: now,
        error: { code: 'timedOut', message: t('error.export.timedOut') },
      },
    });
    return res.count;
  }
}
