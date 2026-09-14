import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsSubscriberModule } from './events-subscriber.module.js';
import { LiveGateway } from './live.gateway.js';

/**
 * API-only live surface (SSE controller + WS gateway) — kept out of
 * EventsModule so worker/MCP contexts never instantiate them (same pattern
 * as GraphQueryModule). AuthModule is global, so TokenAuthService and
 * AccessService resolve without imports.
 */
@Module({
  imports: [EventsSubscriberModule],
  controllers: [EventsController],
  providers: [LiveGateway],
})
export class EventsApiModule {}
