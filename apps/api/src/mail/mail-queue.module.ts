import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { MAIL_QUEUE } from './mail.constants.js';
import { MailProducer } from './mail.producer.js';

/**
 * Producer side only — imported by the API (auth flow, user management) and by
 * `EventsModule`, whose `announce` runs in both processes (docs/features/41).
 *
 * IngestionModule is imported for its `BullModule.forRootAsync` alone, exactly
 * as `ImportQueueModule` does: depending on the Redis root here rather than
 * assuming it means this module cannot load into a context that has none.
 */
@Module({
  imports: [IngestionModule, BullModule.registerQueue({ name: MAIL_QUEUE })],
  providers: [MailProducer],
  exports: [MailProducer],
})
export class MailQueueModule {}
