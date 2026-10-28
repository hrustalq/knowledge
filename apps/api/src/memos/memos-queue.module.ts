import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { MEMO_QUEUE } from './memos.constants.js';
import { MemosProducer } from './memos.producer.js';

/** Producer side (#551), both processes — `ImportQueueModule`'s shape, IngestionModule for the Redis root. */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: MEMO_QUEUE })],
  providers: [MemosProducer],
  exports: [MemosProducer],
})
export class MemosQueueModule {}
