import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { INGESTION_QUEUE } from './ingestion.constants.js';
import { IngestionProducer } from './ingestion.producer.js';
import { redisConnectionFromUrl } from './redis.util.js';

/** Producer side only — imported by both the API and the worker. */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: redisConnectionFromUrl(config.get('REDIS_URL', { infer: true })),
      }),
    }),
    BullModule.registerQueue({ name: INGESTION_QUEUE }),
  ],
  providers: [IngestionProducer],
  exports: [IngestionProducer],
})
export class IngestionModule {}
