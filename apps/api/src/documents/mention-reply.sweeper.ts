import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MentionRepliesService } from './mention-replies.service.js';

/** Nothing here is urgent — a stranded placeholder is rare and already stale. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Closes out agent replies whose turn died with the process (docs/features/21).
 *
 * An @mention answers on a detached continuation, which is precisely the thing
 * a deploy or a crash drops. What it leaves behind is a comment that says the
 * agent is thinking, forever — and a placeholder nobody will ever fill is worse
 * than an error message, because it reads as progress.
 *
 * API-side and interval-driven, like ConnectorConflictSweeper and
 * WorkflowMaterializeSweeper: the repo has no @nestjs/schedule and no BullMQ
 * repeatables, and the work is a bounded `updateMany` rather than something
 * worth a queue.
 */
@Injectable()
export class MentionReplySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MentionReplySweeper.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly mentions: MentionRepliesService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    // Unreffed so a sweep pending in the event loop never holds the process up.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<void> {
    try {
      const closed = await this.mentions.sweepStale();
      if (closed > 0) this.logger.warn(`timed out ${closed} unanswered agent replies`);
    } catch (e: unknown) {
      this.logger.warn(`mention reply sweep failed: ${String(e)}`);
    }
  }
}
