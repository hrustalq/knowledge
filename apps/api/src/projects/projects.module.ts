import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ProjectsCoreModule } from './projects-core.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectOverviewService } from './project-overview.service.js';
import { ProjectCascadeService } from './project-cascade.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { ProjectScaffoldService } from './project-scaffold.service.js';

/**
 * Workspace > Project > Document — the organizational layer above pages.
 * Controller-bearing but also imported by McpModule (knowledge_list_projects),
 * same shape as IngestionAdminModule: its only guard dependencies come from
 * the global AuthModule, so the MCP context can instantiate it safely. Keep it
 * out of WorkerModule, which has no auth at all — the worker imports
 * ProjectsCoreModule instead.
 */
@Module({
  // Storage/graph/fulltext are here for the cascade teardown only. All three
  // are already in the MCP context (which imports this module), and none opens
  // a connection at construction, so they cost that context nothing.
  // Documents, templates and AI skills write a scaffold's pages and conventions (#716).
  imports: [
    ProjectsCoreModule,
    StorageModule,
    GraphModule,
    FulltextModule,
    PermissionsCoreModule,
    DocumentsCoreModule,
    TemplatesCoreModule,
    AiCoreModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectOverviewService, ProjectCascadeService, ProjectScaffoldService],
  // The cascade is exported because connector revert reuses it to undo a page
  // this product otherwise has no way to delete (docs/features/26).
  exports: [ProjectsCoreModule, ProjectCascadeService],
})
export class ProjectsModule {}
