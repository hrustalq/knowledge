import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Ticker } from '../common/ticker.js';
import { MemoryOperationsService } from './memory-operations.service.js';

const TICK_MS = 60_000;

/**
 * The async-retain due checks (#986 phase 3), API-side on one fixed tick with
 * back-pressure: jobs the queue lost, rows a dead worker left claimed, and
 * finished rows past their retention. The rules are `MemoryOperationsService.sweep`.
 */
@Injectable()
export class MemoryOperationsSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryOperationsSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(private readonly operations: MemoryOperationsService) {}

  onModuleInit(): void {
    this.ticker.every(TICK_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    await this.ticker.exclusive(async () => {
      const done = await this.operations.sweep();
      if (done.requeued || done.failed) this.logger.warn(`Memory operations: ${done.requeued} re-queued after a lost worker, ${done.failed} failed`);
    });
  }
}
