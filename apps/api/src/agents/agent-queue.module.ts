import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { AGENT_QUEUE } from './agent.constants.js';
import { AgentProducer } from './agent.producer.js';

/**
 * Producer side only, safe in both processes — the ImportQueueModule split.
 * The processor lives in AgentWorkerModule and is imported by WorkerModule
 * alone; putting it here would make the API start consuming agent jobs.
 *
 * IngestionModule is imported for the shared BullMQ connection registration.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: AGENT_QUEUE })],
  providers: [AgentProducer],
  exports: [AgentProducer, BullModule],
})
export class AgentQueueModule {}
