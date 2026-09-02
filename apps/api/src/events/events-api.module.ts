import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsSubscriber } from './events.subscriber.js';

/**
 * API-only SSE surface — kept out of EventsModule so worker/MCP contexts
 * never instantiate a controller (same pattern as GraphQueryModule).
 */
@Module({
  controllers: [EventsController],
  providers: [EventsSubscriber],
})
export class EventsApiModule {}
