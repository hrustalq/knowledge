import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ChatAnswersService } from './chat-answers.service.js';
import { ChatCapturesService } from './chat-captures.service.js';

/** A stranded placeholder is rare and already late; a minute more is nothing. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Closes out chat answers — and saved conversations still drafting — whose
 * continuation died with the process (issue #71) — the
 * MentionReplySweeper, for a messenger. A chat answer runs on a detached
 * continuation, which is exactly what a deploy drops, and what it leaves
 * behind is a "Searching…" that never changes. That reads as progress, which
 * is worse than an error.
 *
 * API-side and interval-driven, because there is no cron here; off entirely
 * while CHAT_ENABLED is, since nothing can be pending then.
 */
@Injectable()
export class ChatAnswerSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatAnswerSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly answers: ChatAnswersService,
    private readonly captures: ChatCapturesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('CHAT_ENABLED', { infer: true })) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    if (this.running) return; // a slow sweep must not stack on itself
    this.running = true;
    try {
      const closed = await this.answers.reapStale();
      if (closed > 0) this.logger.warn(`timed out ${closed} unanswered chat questions`);
      const dropped = await this.captures.reapStale();
      if (dropped > 0) this.logger.warn(`timed out ${dropped} chat conversations being saved`);
    } catch (e: unknown) {
      this.logger.warn(`chat answer sweep failed: ${String(e)}`);
    } finally {
      this.running = false;
    }
  }
}
