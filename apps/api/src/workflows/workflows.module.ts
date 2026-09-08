import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { WorkflowCoreModule } from './workflow-core.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { DocumentWorkflowsController } from './document-workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';
import { WorkflowMaterializerService } from './workflow-materializer.service.js';
import { WorkflowMaterializeSweeper } from './workflow-materialize.sweeper.js';

/**
 * Dynamic document workflows (docs/features/17). API-only — the controller
 * depends on the global auth guards, so this stays out of WorkerModule and
 * McpModule (same rationale as GraphQueryModule and ImportModule).
 *
 * DocumentsModule is imported for the one thing the worker cannot do: writing
 * an approved draft into the page tree.
 */
@Module({
  imports: [PrismaModule, ActivityModule, DocumentsModule, ProjectsModule, WorkflowCoreModule],
  controllers: [WorkflowsController, DocumentWorkflowsController],
  providers: [WorkflowsService, WorkflowMaterializerService, WorkflowMaterializeSweeper],
  exports: [WorkflowsService, WorkflowMaterializerService],
})
export class WorkflowsModule {}
