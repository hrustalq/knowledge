import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FeedbackCoreModule } from './feedback-core.module.js';
import { KnowledgeIssuesModule } from './knowledge-issues.module.js';
import { AnswerFeedbackController } from './answer-feedback.controller.js';
import { AnswerFeedbackAdminController } from './answer-feedback-admin.controller.js';
import { KnowledgeIssuesController } from './knowledge-issues.controller.js';
import { ReportPublishSweeper } from './report-publish.sweeper.js';

/**
 * API-only half of the answer trust layer (docs/features/38): the vote routes,
 * the admin Feedback tab and export routes,
 * the knowledge-issue routes, and the sweeper that publishes a finished report
 * check and purges what retention says is too old. Carries controllers and a
 * sweeper, so it must never load in the worker — the worker gets
 * `FeedbackCoreModule` on its own.
 *
 * `AiModule` is here for `AgentFindingsService`: a sentinel's draft becomes a
 * merge request through the very path the Propose button takes, with its
 * per-finding claim (the `DriftModule` precedent).
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, AiModule, FeedbackCoreModule, KnowledgeIssuesModule],
  controllers: [AnswerFeedbackController, AnswerFeedbackAdminController, KnowledgeIssuesController],
  providers: [ReportPublishSweeper],
  exports: [FeedbackCoreModule, KnowledgeIssuesModule],
})
export class FeedbackModule {}
