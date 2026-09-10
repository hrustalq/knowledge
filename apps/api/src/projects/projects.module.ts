import { Module } from '@nestjs/common';
import { ProjectsCoreModule } from './projects-core.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectOverviewService } from './project-overview.service.js';
import { ProjectCascadeService } from './project-cascade.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';

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
  imports: [ProjectsCoreModule, StorageModule, GraphModule, FulltextModule],
  controllers: [ProjectsController],
  providers: [ProjectOverviewService, ProjectCascadeService],
  exports: [ProjectsCoreModule],
})
export class ProjectsModule {}
