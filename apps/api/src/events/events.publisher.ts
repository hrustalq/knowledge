import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { KnowledgeEvent } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { EVENTS_CHANNEL } from './events.constants.js';

/**
 * Publish side of the live-event bus (docs/features/04): fire-and-forget
 * Redis pub/sub. Used by the API (activity records) and the worker
 * (revision lifecycle). Delivery is best-effort by design — the UI refetches
 * on navigation, so a lost event never corrupts state.
 */
@Injectable()
export class EventsPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(EventsPublisher.name);
  private readonly redis: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.redis = new Redis(config.get('REDIS_URL', { infer: true }), { lazyConnect: true });
  }

  async publish(event: Omit<KnowledgeEvent, 'at'>): Promise<void> {
    try {
      const payload: KnowledgeEvent = { ...event, at: new Date().toISOString() };
      await this.redis.publish(EVENTS_CHANNEL, JSON.stringify(payload));
    } catch (e) {
      this.logger.warn(`Event publish failed (non-fatal): ${(e as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
