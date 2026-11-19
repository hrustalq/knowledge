import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { ActivityService } from './activity.service.js';

/**
 * The activity recorder with no controller and no auth dependencies, so worker
 * contexts can import it. Same shape as AiCoreModule / EventsModule: the
 * controller-bearing ActivityModule imports this and re-exports it, which keeps
 * every existing `imports: [ActivityModule]` call site working unchanged.
 */
@Module({
  // AuthCoreModule for AuditService alone (Prisma only, both processes): an admin write's feed row is
  // copied into the audit trail (#1251).
  imports: [EventsModule, AuthCoreModule],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityCoreModule {}
