import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { WORKFLOW_QUEUE } from './workflow.constants.js';
import { WorkflowProducer } from './workflow.producer.js';

/**
 * Producer side only (docs/features/17), so it is safe to import into both the
 * API and the worker — same split as `ImportQueueModule`. The processor lives
 * in `WorkflowWorkerModule` and is imported by `WorkerModule` alone; putting it
 * here would make the API process start consuming jobs.
 *
 * `IngestionModule` is imported for the shared BullMQ connection registration.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: WORKFLOW_QUEUE })],
  providers: [WorkflowProducer],
  exports: [WorkflowProducer, BullModule],
})
export class WorkflowQueueModule {}
