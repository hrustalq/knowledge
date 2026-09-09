import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { ActivityService } from './activity.service.js';

/**
 * The activity recorder with no controller and no auth dependencies, so worker
 * contexts can import it. Same shape as AiCoreModule / EventsModule: the
 * controller-bearing ActivityModule imports this and re-exports it, which keeps
 * every existing `imports: [ActivityModule]` call site working unchanged.
 */
@Module({
  imports: [EventsModule],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityCoreModule {}
