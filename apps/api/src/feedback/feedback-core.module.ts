import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProvenanceService } from './provenance.service.js';
import { AnswerFeedbackService } from './answer-feedback.service.js';
import { FeedbackDatasetService } from './feedback-dataset.service.js';

/**
 * The answer trust layer (docs/features/38, issue #67), controller-free so
 * both processes can load it. Phase 1 is provenance, phase 2 the votes and
 * implicit signals; the knowledge-issue service of phase 3 joins here, and
 * `FeedbackModule` (API-only) carries the controllers.
 *
 * Exported for injection into `AssistantService`, `AssistantThreadsService`
 * and `McpService`, which live in modules that import this one.
 * `FeedbackDatasetService` (phase 5) is the admin read side and the backtest
 * dataset; the script reaches it through the application context.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProvenanceService, AnswerFeedbackService, FeedbackDatasetService],
  exports: [ProvenanceService, AnswerFeedbackService, FeedbackDatasetService],
})
export class FeedbackCoreModule {}
