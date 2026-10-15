import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from './permissions-core.module.js';
import { GroupsController } from './groups.controller.js';
import { AccessController } from './access.controller.js';
import { AccessRequestsController } from './access-requests.controller.js';
import { AccessRequestSweeper } from './access-request.sweeper.js';

/**
 * Page permissions (#76), API-only: the controllers depend on the global auth
 * guards, so this stays out of WorkerModule and McpModule. The services live in
 * PermissionsCoreModule, re-exported here.
 */
@Module({
  imports: [PermissionsCoreModule],
  controllers: [GroupsController, AccessController, AccessRequestsController],
  // API-side: the expiry sweep notifies requesters (#76, phase 5).
  providers: [AccessRequestSweeper],
  exports: [PermissionsCoreModule],
})
export class PermissionsModule {}
