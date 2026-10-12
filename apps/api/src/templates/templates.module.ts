import { Module } from '@nestjs/common';
import { TemplatesCoreModule } from './templates-core.module.js';
import { TemplatesController } from './templates.controller.js';

/** The REST surface for page templates (issue #69). API-only: it carries a controller. */
@Module({
  imports: [TemplatesCoreModule],
  controllers: [TemplatesController],
  exports: [TemplatesCoreModule],
})
export class TemplatesModule {}
