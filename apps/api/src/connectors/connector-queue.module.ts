import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { CONNECTOR_QUEUE } from './connector.constants.js';
import { ConnectorProducer } from './connector.producer.js';

/**
 * Producer side, imported by both the API and the worker. IngestionModule is
 * imported for its BullModule.forRootAsync alone: that registers the Redis
 * connection globally (the ImportQueueModule precedent).
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: CONNECTOR_QUEUE })],
  providers: [ConnectorProducer],
  exports: [ConnectorProducer],
})
export class ConnectorQueueModule {}
