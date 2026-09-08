import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { IMPORT_QUEUE } from './import.constants.js';
import { ImportProducer } from './import.producer.js';

/**
 * Producer side only — imported by both the API (which enqueues) and the worker
 * (which consumes), exactly like `IngestionModule`.
 *
 * IngestionModule is imported for its `BullModule.forRootAsync` alone: that
 * registers the Redis connection globally, and depending on it here rather than
 * assuming it means this module cannot be loaded into a context that has none.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: IMPORT_QUEUE })],
  providers: [ImportProducer],
  exports: [ImportProducer],
})
export class ImportQueueModule {}
