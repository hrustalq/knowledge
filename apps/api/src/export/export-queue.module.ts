import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { EXPORT_QUEUE } from './export.constants.js';
import { ExportProducer } from './export.producer.js';

/**
 * Producer side of exports (docs/features/45) — imported by the API (a person
 * asked) and the MCP server (`knowledge_export`). IngestionModule is imported
 * for its `BullModule.forRootAsync` alone, as ImportQueueModule does.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: EXPORT_QUEUE })],
  providers: [ExportProducer],
  exports: [ExportProducer],
})
export class ExportQueueModule {}
