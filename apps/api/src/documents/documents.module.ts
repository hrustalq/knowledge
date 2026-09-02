import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { CompareService } from './compare.service.js';
import { MergeRequestsController } from './merge-requests.controller.js';
import { MergeRequestsService } from './merge-requests.service.js';
import { HistoryService } from './history.service.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [ActivityModule, StorageModule, GraphModule, IngestionModule],
  controllers: [DocumentsController, MergeRequestsController],
  providers: [DocumentsService, CompareService, MergeRequestsService, HistoryService],
  exports: [DocumentsService, CompareService, MergeRequestsService, HistoryService],
})
export class DocumentsModule {}
