import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsSubscriber } from './events.subscriber.js';
import { LiveGateway } from './live.gateway.js';

/**
 * API-only live surface (SSE controller + WS gateway) — kept out of
 * EventsModule so worker/MCP contexts never instantiate them (same pattern
 * as GraphQueryModule). AuthModule is global, so TokenAuthService and
 * AccessService resolve without imports.
 */
@Module({
  controllers: [EventsController],
  providers: [EventsSubscriber, LiveGateway],
})
export class EventsApiModule {}
