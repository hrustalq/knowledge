import { Module } from '@nestjs/common';
import { EventsPublisher } from './events.publisher.js';

/** Publisher only — safe to import from the worker and MCP contexts. */
@Module({
  providers: [EventsPublisher],
  exports: [EventsPublisher],
})
export class EventsModule {}
