import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Subject, filter, interval, map, merge, type Observable } from 'rxjs';
import type { KnowledgeEvent } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { EVENTS_CHANNEL } from './events.constants.js';

/** SSE `data:` frame shape expected by @nestjs @Sse. */
interface SseMessage {
  data: KnowledgeEvent;
}

/**
 * Subscribe side of the live-event bus (docs/features/04): one Redis
 * subscriber connection per API process fanning out to an in-process subject;
 * each SSE client gets a workspace-filtered stream with a 30s heartbeat.
 */
@Injectable()
export class EventsSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsSubscriber.name);
  private readonly redis: Redis;
  private readonly subject = new Subject<KnowledgeEvent>();
  /** Set once the channel is actually attached; drives the reconnect retry. */
  private subscribed = false;

  constructor(config: ConfigService<Env, true>) {
    this.redis = new Redis(config.get('REDIS_URL', { infer: true }), { lazyConnect: true });
  }

  async onModuleInit(): Promise<void> {
    // Two ordering rules here, both load-bearing.
    //
    // 1. The message listener is registered BEFORE the subscribe and outside the
    //    try. Registering it after the await meant a rejected subscribe skipped
    //    it entirely.
    // 2. A failed FIRST subscribe has to be retried by hand. ioredis only
    //    auto-resubscribes a channel it has already subscribed to successfully
    //    (`autoResubscribe` is gated on `condition.subscriber`), so when Redis is
    //    not up yet at boot — ordinary container start ordering — nothing ever
    //    reattaches. That left the process deaf for its whole lifetime: no SSE,
    //    no WS frames, and no WorkflowTriggerService, behind one boot-time warn.
    this.redis.on('message', (_channel, message) => {
      try {
        this.subject.next(JSON.parse(message) as KnowledgeEvent);
      } catch {
        this.logger.warn(`Dropping malformed event payload: ${message.slice(0, 120)}`);
      }
    });
    // `ready` fires on every (re)connection; the guard makes this a no-op once
    // the channel is attached, leaving ioredis's own resubscribe to do the rest.
    this.redis.on('ready', () => {
      if (!this.subscribed) void this.attach();
    });
    await this.attach();
  }

  /**
   * `subscribed` alone cannot guard this: it is only set AFTER the await, and
   * with `lazyConnect` the very first `subscribe()` is what opens the
   * connection — so `ready` fires while that first call is still in flight, the
   * guard is still false, and the channel is subscribed twice. Harmless at the
   * protocol level (a repeat SUBSCRIBE on one connection is a no-op and the
   * 'message' listener is registered once), but it logged two "Subscribed"
   * lines at every boot, which reads as two subscribers.
   */
  private attaching = false;

  private async attach(): Promise<void> {
    if (this.attaching || this.subscribed) return;
    this.attaching = true;
    try {
      await this.redis.subscribe(EVENTS_CHANNEL);
      this.subscribed = true;
      this.logger.log(`Subscribed to ${EVENTS_CHANNEL}`);
    } catch (e) {
      this.logger.warn(
        `Event subscription unavailable, retrying on reconnect: ${(e as Error).message}`,
      );
    } finally {
      // Cleared either way: a failed attempt must leave the next `ready` free
      // to retry, which is the whole point of the retry path.
      this.attaching = false;
    }
  }

  /** Unfiltered firehose for in-process consumers (LiveGateway does its own ACL + tracking filtering). */
  all(): Observable<KnowledgeEvent> {
    return this.subject.asObservable();
  }

  /**
   * One client's feed.
   *
   * `userId` is what makes per-person events safe on a shared bus: a frame
   * carrying `event.userId` is addressed, and delivering it to the rest of the
   * workspace would broadcast who is being notified about what
   * (docs/features/22). A frame without one stays a workspace broadcast.
   */
  stream(workspaceId: string, userId?: string): Observable<SseMessage> {
    const events = this.subject.pipe(
      filter((e) => e.workspaceId === workspaceId),
      filter((e) => !e.userId || e.userId === userId),
      map((e) => ({ data: e })),
    );
    // Heartbeat keeps proxies from closing idle SSE connections.
    const heartbeat = interval(30_000).pipe(
      map(() => ({ data: { type: 'ping', workspaceId, at: new Date().toISOString() } as KnowledgeEvent })),
    );
    return merge(events, heartbeat);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
    this.subject.complete();
  }
}
