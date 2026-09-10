import { Module } from '@nestjs/common';
import { ProjectsCoreModule } from './projects-core.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectOverviewService } from './project-overview.service.js';

/**
 * Workspace > Project > Document — the organizational layer above pages.
 * Controller-bearing but also imported by McpModule (knowledge_list_projects),
 * same shape as IngestionAdminModule: its only guard dependencies come from
 * the global AuthModule, so the MCP context can instantiate it safely. Keep it
 * out of WorkerModule, which has no auth at all — the worker imports
 * ProjectsCoreModule instead.
 */
@Module({
  imports: [ProjectsCoreModule],
  controllers: [ProjectsController],
  providers: [ProjectOverviewService],
  exports: [ProjectsCoreModule],
})
export class ProjectsModule {}
