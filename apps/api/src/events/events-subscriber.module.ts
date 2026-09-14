import { Module } from '@nestjs/common';
import { EventsSubscriber } from './events.subscriber.js';

/**
 * The Redis subscriber connection, on its own so both consumers share one.
 *
 * It was the last duplicated provider in the repo: listed in
 * `EventsApiModule` (for the SSE controller and the WS gateway) and again in
 * `WorkflowWorkerModule` (for event-triggered runs), exported by neither — so
 * each context built its own, and neither could be reached from anywhere else.
 *
 * The `AssistantClientModule` treatment: one module, one instance, one
 * connection. `EventsModule` deliberately does NOT import this — that is the
 * publish side, and a worker that only publishes should not open a subscriber.
 */
@Module({
  providers: [EventsSubscriber],
  exports: [EventsSubscriber],
})
export class EventsSubscriberModule {}
