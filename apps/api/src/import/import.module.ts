import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { ImportQueueModule } from './import-queue.module.js';
import { ImportController } from './import.controller.js';
import { ImportService } from './import.service.js';

/**
 * Document import (docs/features/16), API side.
 *
 * Controller-bearing and therefore API-only — the same rule that keeps
 * GraphQueryModule and IngestionAdminModule out of the worker: its guards need
 * AccessService, which a worker context has no business instantiating. The
 * parsing half lives in ImportWorkerModule and is imported only by
 * worker.module.ts.
 */
@Module({
  imports: [StorageModule, ProjectsModule, DocumentsModule, ActivityModule, ImportQueueModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
