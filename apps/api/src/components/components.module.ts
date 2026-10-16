import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ComponentsCoreModule } from './components-core.module.js';
import { CodeUsagesController, ComponentsController } from './components.controller.js';

/** The REST surface for component declarations and their usages (#236). API-only: it carries controllers. */
@Module({
  imports: [ComponentsCoreModule, PermissionsCoreModule],
  controllers: [ComponentsController, CodeUsagesController],
  exports: [ComponentsCoreModule],
})
export class ComponentsModule {}
