import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { Module } from '@nestjs/common';
import { TemplatesCoreModule } from './templates-core.module.js';
import { TemplatesController } from './templates.controller.js';

/** The REST surface for page templates (issue #69). API-only: it carries a controller. */
@Module({
  imports: [TemplatesCoreModule, PermissionsCoreModule],
  controllers: [TemplatesController],
  exports: [TemplatesCoreModule],
})
export class TemplatesModule {}
