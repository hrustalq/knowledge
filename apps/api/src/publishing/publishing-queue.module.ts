import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { SITE_BUILD_QUEUE } from './site-build.constants.js';
import { SiteBuildProducer } from './site-build.producer.js';

/**
 * Producer side of site builds (docs/features/44) — imported by the API and
 * the worker. IngestionModule is imported for its `BullModule.forRootAsync`
 * alone, as MailQueueModule does.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: SITE_BUILD_QUEUE })],
  providers: [SiteBuildProducer],
  exports: [SiteBuildProducer],
})
export class PublishingQueueModule {}
