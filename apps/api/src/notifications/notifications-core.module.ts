import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';

/**
 * The fan-out and the inbox with no controller and no auth dependencies.
 *
 * Controller-free for two reasons rather than one. The usual one: worker
 * contexts import it (the processors publish events, and publishing is what
 * triggers a notification). The load-bearing one: `EventsModule` imports this,
 * and `EventsModule` is imported by nearly everything — a controller here would
 * drag the global auth guards into the worker and the MCP server.
 *
 * `NotificationsService` therefore takes `PrismaService` and nothing else,
 * which is what keeps that import a plain one instead of a `forwardRef`.
 */
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsCoreModule {}
