import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ProjectsService } from './projects.service.js';

/**
 * Workspace > Project > Document, without the controller — so the worker can
 * resolve projects while writing pages (docs/features/19). The controller-bearing
 * ProjectsModule imports this and re-exports it.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule, PermissionsCoreModule],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsCoreModule {}
