import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { ActivityService } from './activity.service.js';
import { ActivityController } from './activity.controller.js';

@Module({
  imports: [EventsModule],
  controllers: [ActivityController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
