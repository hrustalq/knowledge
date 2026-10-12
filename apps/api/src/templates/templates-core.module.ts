import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { TemplatesService } from './templates.service.js';

/**
 * Page templates without the controller (issue #69), so the processes that
 * cannot load auth — the worker drafting a workflow page, DocumentsCoreModule
 * creating one — can resolve and render a template. TemplatesModule imports
 * this and re-exports it.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule, ProjectsCoreModule],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesCoreModule {}
