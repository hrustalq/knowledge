import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { MEMORY_QUEUE } from './memory.constants.js';
import { MemoryProducer } from './memory.producer.js';

/**
 * Producer side of async retain (#986 phase 3), for both processes: the API
 * enqueues, and the worker's module needs the queue registered to consume it.
 * IngestionModule is imported for its `BullModule.forRootAsync` alone, as
 * ExportQueueModule does.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: MEMORY_QUEUE })],
  providers: [MemoryProducer],
  exports: [MemoryProducer],
})
export class MemoryQueueModule {}
