import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatBufferService } from './chat-buffer.service.js';
import { ChatMessagesService } from './chat-messages.service.js';
import { Ticker } from '../common/ticker.js';

/** A stranded placeholder is rare and already late; a minute more is nothing. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Closes out chat answers whose continuation died with the process (issue
 * #71) — the
 * MentionReplySweeper, for a messenger. A chat answer runs on a detached
 * continuation, which is exactly what a deploy drops, and what it leaves
 * behind is a "Searching…" that never changes. That reads as progress, which
 * is worse than an error.
 *
 * API-side and interval-driven, because there is no cron here. The same tick
 * drops kept chat messages past their keep — the harvest buffer's (#82) and
 * a searchable group's (#339) — and that part runs even while CHAT_ENABLED
 * is off: a retention is a promise about rows already written.
 */
@Injectable()
export class ChatAnswerSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatAnswerSweeper.name);
  private readonly ticker = new Ticker(this.logger);

  constructor(
    private readonly answers: ChatAnswersService,
    private readonly buffer: ChatBufferService,
    private readonly config: ConfigService<Env, true>,
    private readonly messages: ChatMessagesService,
  ) {}

  onModuleInit(): void {
    this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      if (this.config.get('CHAT_ENABLED', { infer: true })) {
        const closed = await this.answers.reapStale();
        if (closed > 0) this.logger.warn(`timed out ${closed} unanswered chat questions`);
      }
      await this.buffer.purgeExpired();
      await this.messages.purgeExpired();
    });
  }
}
