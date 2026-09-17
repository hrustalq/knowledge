import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ConnectorAdaptersModule } from './adapters/adapters.module.js';
import { ConnectorDiscoveryService } from './connector-discovery.service.js';
import { ConnectorLinksService } from './connector-links.service.js';
import { ConnectorStagingService } from './connector-staging.service.js';
import { ConnectorSyncService } from './connector-sync.service.js';
import { ConnectorsService } from './connectors.service.js';
import { GithubCoreModule } from './github/github-core.module.js';

/**
 * Connector configuration, credentials, links and the sync engine, with no
 * controllers and no auth dependencies — so the worker can import it
 * (docs/features/19). The AiCoreModule / WorkflowCoreModule shape.
 *
 * Note DocumentsCoreModule rather than DocumentsModule: the sync engine writes
 * pages in bulk from the worker, which is exactly why that split exists.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    EventsModule,
    ProjectsCoreModule,
    DocumentsCoreModule,
    ConnectorAdaptersModule,
    // ConnectorsService resolves a picker-configured connector's credential to
    // a freshly minted installation token, so the worker needs this too.
    GithubCoreModule,
  ],
  providers: [
    ConnectorsService,
    ConnectorLinksService,
    ConnectorDiscoveryService,
    ConnectorStagingService,
    ConnectorSyncService,
  ],
  exports: [
    ConnectorsService,
    ConnectorLinksService,
    ConnectorDiscoveryService,
    ConnectorStagingService,
    ConnectorSyncService,
  ],
})
export class ConnectorsCoreModule {}
