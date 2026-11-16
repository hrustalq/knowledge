import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ContextCoreModule } from './context-core.module.js';
import { ContextController } from './context.controller.js';

/** API side: POST /v1/context on top of ContextCoreModule's service. */
@Module({
  imports: [ContextCoreModule, PermissionsCoreModule],
  controllers: [ContextController],
  exports: [ContextCoreModule],
})
export class ContextModule {}
