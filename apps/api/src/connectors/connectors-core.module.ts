import { Module } from '@nestjs/common';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ConnectorAdaptersModule } from './adapters/adapters.module.js';
import { CodeImportsService } from './code-imports.service.js';
import { ConnectorAclService } from './connector-acl.service.js';
import { ConnectorDiscoveryService } from './connector-discovery.service.js';
import { ConnectorLinksService } from './connector-links.service.js';
import { ConnectorStagingService } from './connector-staging.service.js';
import { ConnectorSyncService } from './connector-sync.service.js';
import { ConnectorsService } from './connectors.service.js';
import { GithubCoreModule } from './github/github-core.module.js';
import { RepoWikiService } from './repo-wiki.service.js';

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
    // Access mirroring (#76): restricting a page it writes, and announcing it.
    PermissionsCoreModule,
  ],
  providers: [
    ConnectorsService,
    ConnectorAclService,
    ConnectorLinksService,
    ConnectorDiscoveryService,
    ConnectorStagingService,
    ConnectorSyncService,
    RepoWikiService,
    CodeImportsService,
  ],
  exports: [
    ConnectorsService,
    ConnectorAclService,
    ConnectorLinksService,
    ConnectorDiscoveryService,
    ConnectorStagingService,
    ConnectorSyncService,
    // The repo wiki's read side and regenerate (docs/features/46): shared by
    // the REST routes and the MCP tools, so exported like the rest.
    RepoWikiService,
    // The code-usage index (#236): written by the pull, read by the usage
    // routes and MCP tools of later phases.
    CodeImportsService,
  ],
})
export class ConnectorsCoreModule {}
