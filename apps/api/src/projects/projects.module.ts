import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

/**
 * Workspace > Project > Document — the organizational layer above pages.
 * Controller-bearing but also imported by McpModule (knowledge_list_projects),
 * same shape as IngestionAdminModule: its only guard dependencies come from
 * the global AuthModule, so the MCP context can instantiate it safely. Keep it
 * out of WorkerModule, which has no auth at all.
 */
@Module({
  imports: [PrismaModule, ActivityModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
