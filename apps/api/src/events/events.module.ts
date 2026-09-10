import { Module } from '@nestjs/common';
import { EventsPublisher } from './events.publisher.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';

/**
 * Publisher only — safe to import from the worker and MCP contexts.
 *
 * NotificationsCoreModule is imported, not `forwardRef`ed: `NotificationsService`
 * takes `PrismaService` (global) and nothing else, so there is no cycle to
 * break. It must stay that way — a dependency there that reached back for
 * `EventsPublisher` would turn this into one.
 */
@Module({
  imports: [NotificationsCoreModule],
  providers: [EventsPublisher],
  exports: [EventsPublisher],
})
export class EventsModule {}
