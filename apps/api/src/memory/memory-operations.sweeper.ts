import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Ticker } from '../common/ticker.js';
import { MemoryMentalModelsService } from './memory-mental-models.service.js';
import { MemoryOperationsService } from './memory-operations.service.js';

const TICK_MS = 60_000;

/**
 * Memory operation due checks, API-side on one fixed tick with back-pressure:
 * lost jobs, stale claims, retention, mental-model schedules and parked refreshes.
 */
@Injectable()
export class MemoryOperationsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryOperationsSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly operations: MemoryOperationsService,
    private readonly mentalModels: MemoryMentalModelsService,
  ) {}

  onModuleInit(): void {
    this.ticker.every(TICK_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    await this.ticker.exclusive(async () => {
      const done = await this.operations.sweep();
      await this.mentalModels.sweep();
      if (done.requeued || done.failed) this.logger.warn(`Memory operations: ${done.requeued} re-queued after a lost worker, ${done.failed} failed`);
    });
  }
}
