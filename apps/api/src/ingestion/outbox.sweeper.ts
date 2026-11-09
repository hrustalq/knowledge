import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { IngestionProducer } from './ingestion.producer.js';
import { Ticker } from '../common/ticker.js';

/**
 * Cheap outbox (plan.md §5): job rows are committed with the revision status
 * change; if the post-commit enqueue was lost, re-enqueue stale queued rows.
 * BullMQ jobId dedupe makes double-enqueues harmless.
 */
@Injectable()
export class OutboxSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly prisma: PrismaService,
    private readonly producer: IngestionProducer,
  ) {}

  onModuleInit() {
    this.ticker.every(30_000, () => this.sweep());
  }

  onModuleDestroy() {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      const stale = await this.prisma.ingestionJob.findMany({
        where: { status: 'queued', createdAt: { lt: new Date(Date.now() - 60_000) } },
        take: 20,
        orderBy: { createdAt: 'asc' },
      });
      for (const job of stale) {
        this.logger.log(`Re-enqueueing stale ingestion job ${job.id}`);
        await this.producer.enqueue(job.id);
      }
    });
  }
}
