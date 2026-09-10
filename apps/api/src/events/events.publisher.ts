import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { KnowledgeEvent } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { EVENTS_CHANNEL } from './events.constants.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/**
 * Publish side of the live-event bus (docs/features/04): fire-and-forget
 * Redis pub/sub. Used by the API (activity records) and the worker
 * (revision lifecycle). Delivery is best-effort by design — the UI refetches
 * on navigation, so a lost event never corrupts state.
 *
 * ## Also the notification fan-out point (docs/features/22)
 *
 * This is the one function every event in the system already passes through:
 * `ActivityService.record` on the API side, and the ingestion, workflow, agent,
 * import and connector processors publishing directly on the worker side. So
 * the per-person fan-out hooks here rather than at those call sites — the same
 * "single injection point" reasoning `GraphService` uses for the mandatory
 * workspace predicate, and the reason a notifiable event type added later costs
 * one entry in `notificationCategoryFor` and no wiring.
 *
 * The recursion that would otherwise be obvious is closed off by the code
 * table: `notification.created` maps to no category, so a notification cannot
 * fan out into another one.
 */
@Injectable()
export class EventsPublisher implements OnModuleDestroy {
  private readonly logger = new Logger(EventsPublisher.name);
  private readonly redis: Redis;

  constructor(
    config: ConfigService<Env, true>,
    private readonly notifications: NotificationsService,
  ) {
    this.redis = new Redis(config.get('REDIS_URL', { infer: true }), { lazyConnect: true });
  }

  async publish(event: Omit<KnowledgeEvent, 'at'>): Promise<void> {
    const payload: KnowledgeEvent = { ...event, at: new Date().toISOString() };
    try {
      await this.redis.publish(EVENTS_CHANNEL, JSON.stringify(payload));
    } catch (e) {
      this.logger.warn(`Event publish failed (non-fatal): ${(e as Error).message}`);
    }
    // After the broadcast, never before: an inbox write must not be able to
    // delay or swallow the live update everybody else is waiting for.
    await this.fanOut(payload);
  }

  /**
   * Write inbox rows for this event, then tell each recipient — and only that
   * recipient — that they have one.
   *
   * The per-person frame carries `userId`, which both fan-out sites (the SSE
   * stream and the WS gateway) filter on. Publishing it without one would push
   * every notification to every peer in the workspace, telling them who is
   * watching what.
   */
  private async fanOut(event: KnowledgeEvent): Promise<void> {
    try {
      const deliveries = await this.notifications.fanOut(event);
      for (const { userId, notification } of deliveries) {
        const frame: KnowledgeEvent = {
          type: 'notification.created',
          workspaceId: event.workspaceId,
          userId,
          subjectId: notification.id,
          reason: notification.reason,
          ...(notification.documentId ? { documentId: notification.documentId } : {}),
          ...(notification.title ? { title: notification.title } : {}),
          ...(notification.actor ? { actor: notification.actor } : {}),
          at: new Date().toISOString(),
        };
        await this.redis.publish(EVENTS_CHANNEL, JSON.stringify(frame));
      }
    } catch (e) {
      this.logger.warn(`Notification fan-out failed (non-fatal): ${(e as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }
}
