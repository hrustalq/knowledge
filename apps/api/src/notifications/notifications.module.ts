import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from './notifications-core.module.js';
import { NotificationsController } from './notifications.controller.js';

/**
 * API side: the inbox endpoints on top of NotificationsCoreModule.
 *
 * API-only — the controller depends on the global auth guards, so this stays
 * out of WorkerModule and McpModule. Re-exports Core so every existing
 * `imports: [NotificationsModule]` still resolves the service (the
 * ActivityModule / GlossaryModule shape).
 */
@Module({
  imports: [NotificationsCoreModule],
  controllers: [NotificationsController],
  exports: [NotificationsCoreModule],
})
export class NotificationsModule {}
