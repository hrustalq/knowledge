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

  constructor(config: ConfigService<Env, true>) {
    this.redis = new Redis(config.get('REDIS_URL', { infer: true }), { lazyConnect: true });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.redis.subscribe(EVENTS_CHANNEL);
      this.redis.on('message', (_channel, message) => {
        try {
          this.subject.next(JSON.parse(message) as KnowledgeEvent);
        } catch {
          this.logger.warn(`Dropping malformed event payload: ${message.slice(0, 120)}`);
        }
      });
    } catch (e) {
      this.logger.warn(`Event subscription unavailable: ${(e as Error).message}`);
    }
  }

  stream(workspaceId: string): Observable<SseMessage> {
    const events = this.subject.pipe(
      filter((e) => e.workspaceId === workspaceId),
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
