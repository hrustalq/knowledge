import { Module } from '@nestjs/common';
import { ActivityCoreModule } from './activity-core.module.js';
import { ActivityController } from './activity.controller.js';

/** API side: the feed endpoint on top of ActivityCoreModule's recorder. */
@Module({
  imports: [ActivityCoreModule],
  controllers: [ActivityController],
  exports: [ActivityCoreModule],
})
export class ActivityModule {}
