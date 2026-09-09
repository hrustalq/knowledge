import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { DocumentsCoreModule } from './documents-core.module.js';
import { DocumentsController } from './documents.controller.js';
import { CompareService } from './compare.service.js';
import { MergeRequestsController } from './merge-requests.controller.js';
import { MergeRequestsService } from './merge-requests.service.js';
import { MergeRequestThreadsService } from './merge-request-threads.service.js';
import { SavedFiltersService } from './saved-filters.service.js';
import { DocumentThreadsService } from './document-threads.service.js';
import { HistoryService } from './history.service.js';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { ConnectorQueueModule } from '../connectors/connector-queue.module.js';

/**
 * API side. DocumentsService itself lives in DocumentsCoreModule (worker-safe);
 * everything here needs either a controller or AccessService, so it stays out
 * of WorkerModule.
 */
@Module({
  imports: [
    DocumentsCoreModule,
    ActivityModule,
    StorageModule,
    GraphModule,
    IngestionModule,
    ProjectsModule,
    // The page-side connector surface (docs/features/19): 'linked to' and 'push now'.
    ConnectorsCoreModule,
    ConnectorQueueModule,
  ],
  controllers: [DocumentsController, MergeRequestsController],
  providers: [
    CompareService,
    MergeRequestsService,
    MergeRequestThreadsService,
    SavedFiltersService,
    DocumentThreadsService,
    HistoryService,
  ],
  exports: [
    DocumentsCoreModule,
    CompareService,
    MergeRequestsService,
    MergeRequestThreadsService,
    DocumentThreadsService,
    HistoryService,
  ],
})
export class DocumentsModule {}
