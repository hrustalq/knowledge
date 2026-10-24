import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { API_TEST_RUN_QUEUE, ApiTestRunProducer } from './api-test-run.producer.js';

/**
 * Producer side of the QA server runner (#483, phase 5). IngestionModule is
 * imported for its `BullModule.forRootAsync` alone, as MailQueueModule does.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: API_TEST_RUN_QUEUE })],
  providers: [ApiTestRunProducer],
  exports: [ApiTestRunProducer],
})
export class ApiTestRunQueueModule {}
