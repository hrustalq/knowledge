import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MentionRepliesService } from './mention-replies.service.js';
import { Ticker } from '../common/ticker.js';

/** Nothing here is urgent — a stranded placeholder is rare and already stale. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Closes out agent replies whose turn died with the process (docs/features/21),
 * and fills the ones answered by an agent run once that run finishes (#70).
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
  private readonly ticker = new Ticker(this.logger);

  constructor(private readonly mentions: MentionRepliesService) {}

  onModuleInit(): void {
    this.ticker.every(SWEEP_INTERVAL_MS, () => this.sweep());
  }

  onModuleDestroy(): void {
    this.ticker.stop();
  }

  async sweep(): Promise<void> {
    return this.ticker.exclusive(async () => {
      // Run replies first: a run that finished just inside the backstop is an
      // answer, not a timeout.
      const answered = await this.mentions.sweepRunReplies();
      if (answered > 0) this.logger.log(`posted ${answered} agent run replies`);
      const closed = await this.mentions.sweepStale();
      if (closed > 0) this.logger.warn(`timed out ${closed} unanswered agent replies`);
    });
  }
}
