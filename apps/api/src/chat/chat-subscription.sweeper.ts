import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ChatSubscriptionsService } from './chat-subscriptions.service.js';

/**
 * Tells subscribed groups what changed (issue #71, phase 3). One path for
 * both modes: an instant rule is due every tick, a digest once its window has
 * passed. A due check inside a fixed tick, never a second sweep while one is
 * in flight — there is no cron here.
 *
 * API-side, beside the answer sweeper: the bot's token, the adapters and the
 * rest of the chat module live in the API process, and a post to a group is
 * attributed to nobody. Two API processes cannot double-send — the cursor
 * claim in `ChatSubscriptionsService.deliver` decides who sends.
 */
@Injectable()
export class ChatSubscriptionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatSubscriptionSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly subscriptions: ChatSubscriptionsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('CHAT_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.sweep(), this.config.get('CHAT_DIGEST_TICK_MS', { infer: true }));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sent = await this.subscriptions.deliverDue();
      if (sent > 0) this.logger.log(`sent ${sent} chat subscription updates`);
    } catch (e: unknown) {
      this.logger.warn(`chat subscription sweep failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
