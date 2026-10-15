import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsSubscriberModule } from './events-subscriber.module.js';
import { LiveGateway } from './live.gateway.js';
import { LiveVisibility } from './live-visibility.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';

/**
 * API-only live surface (SSE controller + WS gateway) — kept out of
 * EventsModule so worker/MCP contexts never instantiate them (same pattern
 * as GraphQueryModule). AuthModule is global, so TokenAuthService and
 * AccessService resolve without imports.
 */
@Module({
  // PermissionsCoreModule: frames about a page reach only those who can open it (#76).
  imports: [EventsSubscriberModule, PermissionsCoreModule],
  controllers: [EventsController],
  providers: [LiveGateway, LiveVisibility],
})
export class EventsApiModule {}
