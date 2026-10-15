import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from './permissions-core.module.js';
import { GroupsController } from './groups.controller.js';
import { AccessController } from './access.controller.js';

/**
 * Page permissions (#76), API-only: the controllers depend on the global auth
 * guards, so this stays out of WorkerModule and McpModule. The services live in
 * PermissionsCoreModule, re-exported here.
 */
@Module({
  imports: [PermissionsCoreModule],
  controllers: [GroupsController, AccessController],
  exports: [PermissionsCoreModule],
})
export class PermissionsModule {}
