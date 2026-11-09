import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../config/env.js';

/**
 * The one ioredis client a process uses for plain commands: event publishes,
 * URL tickets, the read cache, the public routes' counters and sessions, chat
 * inbox claims. A subscriber cannot share it (a subscribed connection takes no
 * other commands), so `EventsSubscriber` and the collab relay keep their own.
 *
 * - Lazy: the OpenAPI generator and the MCP entrypoint boot with no Redis
 *   running, so nothing dials until the first command.
 * - One retry and a 2 s connect timeout bound how long a command against a down
 *   Redis can hold its caller: `publish` sits in request paths through
 *   `ActivityService.record`. The offline queue stays on, because with
 *   `lazyConnect` the first command is what opens the connection.
 * - Every caller handles a rejected command itself (they all fail open), so
 *   the connection's own `error` events are swallowed rather than printed once
 *   per reconnect attempt.
 */
@Injectable()
export class SharedRedis implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis(config.get('REDIS_URL', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
    });
    this.client.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
