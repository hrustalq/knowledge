import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { DocumentsService } from './documents.service.js';

/**
 * Document reads and writes with no controllers and no auth dependencies.
 *
 * This exists so the connector worker (docs/features/19) can create pages,
 * write revisions and finalize them in bulk. DocumentsModule cannot be loaded
 * into WorkerModule: it carries controllers, and MergeRequestsService injects
 * AccessService from the global AuthModule, which the worker never registers.
 * Feature 17 worked around that with an API-side materialize sweeper — the
 * right shape for a rare path, but a pull of several hundred pages would
 * trickle through a sweep interval, so connectors need the real service.
 *
 * Same split as AiCoreModule / WorkflowCoreModule / EventsModule: DocumentsModule
 * imports this and re-exports it, so every existing `imports: [DocumentsModule]`
 * keeps resolving DocumentsService unchanged.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    GraphModule,
    IngestionModule,
    ActivityCoreModule,
    ProjectsCoreModule,
    // Writing a page subscribes its author to it (docs/features/22). Core, so
    // this stays worker-loadable.
    NotificationsCoreModule,
  ],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsCoreModule {}
