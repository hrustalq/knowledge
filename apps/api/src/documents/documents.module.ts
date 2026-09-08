import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import { MergeRequestsController } from './merge-requests.controller.js';
import { MergeRequestsService } from './merge-requests.service.js';
import { MergeRequestThreadsService } from './merge-request-threads.service.js';
import { DocumentThreadsService } from './document-threads.service.js';
import { HistoryService } from './history.service.js';
import { ActivityModule } from '../activity/activity.module.js';
import { ProjectsModule } from '../projects/projects.module.js';

@Module({
  imports: [ActivityModule, StorageModule, GraphModule, IngestionModule, ProjectsModule],
  controllers: [DocumentsController, MergeRequestsController],
  providers: [
    DocumentsService,
    CompareService,
    MergeRequestsService,
    MergeRequestThreadsService,
    DocumentThreadsService,
    HistoryService,
  ],
  exports: [
    DocumentsService,
    CompareService,
    MergeRequestsService,
    MergeRequestThreadsService,
    DocumentThreadsService,
    HistoryService,
  ],
})
export class DocumentsModule {}
