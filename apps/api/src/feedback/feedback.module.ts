import { Module } from '@nestjs/common';
import { FeedbackCoreModule } from './feedback-core.module.js';
import { AnswerFeedbackController } from './answer-feedback.controller.js';

/**
 * API-only half of the answer trust layer (docs/features/38): the vote routes.
 * Carries a controller, so it must never load in the worker — the worker gets
 * `FeedbackCoreModule` on its own. Phase 3 adds the knowledge-issue routes and
 * the report-publish sweeper here.
 */
@Module({
  imports: [FeedbackCoreModule],
  controllers: [AnswerFeedbackController],
  exports: [FeedbackCoreModule],
})
export class FeedbackModule {}
