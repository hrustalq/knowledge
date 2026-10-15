import { Module } from '@nestjs/common';
import { ActivityCoreModule } from './activity-core.module.js';
import { ActivityController } from './activity.controller.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';

/** API side: the feed endpoint on top of ActivityCoreModule's recorder. */
@Module({
  // PermissionsCoreModule: the feed is read through the caller's AccessScope (#76).
  imports: [ActivityCoreModule, PermissionsCoreModule],
  controllers: [ActivityController],
  exports: [ActivityCoreModule],
})
export class ActivityModule {}
