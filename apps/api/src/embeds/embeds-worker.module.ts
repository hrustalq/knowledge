import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EmbedsCoreModule } from './embeds-core.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { EmbedSnapshotService } from './embed-snapshot.service.js';
import { EmbedsProcessor } from './embeds.processor.js';
import { EmbedChangeSweeper } from './embed-change.sweeper.js';

/**
 * Consumer side of embeds — imported ONLY by the worker entrypoint. Importing
 * it into AppModule would make the API process render snapshots.
 */
@Module({
  imports: [PrismaModule, StorageModule, IngestionModule, ConnectorsCoreModule, EmbedsCoreModule],
  providers: [EmbedSnapshotService, EmbedsProcessor, EmbedChangeSweeper],
})
export class EmbedsWorkerModule {}
