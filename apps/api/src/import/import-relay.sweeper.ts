import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImportProducer } from './import.producer.js';

const SWEEP_INTERVAL_MS = 5 * 60_000;
/** Measured from the reservation: `import_jobs` has no `updatedAt`, and a live job absorbs an early relay anyway. */
const STALE_QUEUED_MS = 10 * 60_000;

/**
 * The outbox relay for imports (#657), `OutboxSweeper`'s shape: `start`
 * commits the row `queued` and then enqueues, so a lost enqueue left the parse
 * waiting forever. `jobId = import_jobs.id` makes a re-enqueue of a row whose
 * job still exists a no-op. Worker-only, beside the processor.
 */
@Injectable()
export class ImportRelaySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImportRelaySweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: ImportProducer,
  ) {}

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
      const stale = await this.prisma.importJob.findMany({
        where: { status: 'queued', createdAt: { lt: new Date(Date.now() - STALE_QUEUED_MS) } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      });
      for (const row of stale) {
        this.logger.log(`Re-enqueueing stale queued import ${row.id}`);
        await this.producer.enqueue(row.id);
      }
    } catch (error) {
      this.logger.warn(`Import relay sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
