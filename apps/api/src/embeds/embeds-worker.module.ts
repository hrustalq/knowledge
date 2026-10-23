import { Module } from '@nestjs/common';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EmbedsCoreModule } from './embeds-core.module.js';
import { EmbedSnapshotService } from './embed-snapshot.service.js';
import { EmbedsProcessor } from './embeds.processor.js';

/**
 * Consumer side of embeds — imported ONLY by the worker entrypoint. Importing
 * it into AppModule would make the API process render snapshots.
 */
@Module({
  imports: [PrismaModule, StorageModule, ConnectorsCoreModule, EmbedsCoreModule],
  providers: [EmbedSnapshotService, EmbedsProcessor],
})
export class EmbedsWorkerModule {}
