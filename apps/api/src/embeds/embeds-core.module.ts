import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EMBEDS_QUEUE } from './embeds.constants.js';
import { EmbedsService } from './embeds.service.js';

/**
 * Embeds (#470, docs/features/64), controller-free: recording a revision's
 * items, reading what a reader may see, and queueing renders. Imported by the
 * API (the routes), the worker (ingestion records through it) and later MCP.
 * IngestionModule is here for its `BullModule.forRootAsync`, as for exports.
 */
@Module({
  imports: [PrismaModule, StorageModule, IngestionModule, BullModule.registerQueue({ name: EMBEDS_QUEUE })],
  providers: [EmbedsService],
  exports: [EmbedsService],
})
export class EmbedsCoreModule {}
