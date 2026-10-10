import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ProvenanceService } from './provenance.service.js';

/**
 * The answer trust layer (docs/features/38, issue #67), controller-free so
 * both processes can load it. Phase 1 is provenance only; the feedback and
 * knowledge-issue services of later phases join here, and `FeedbackModule`
 * (API-only) will carry their controllers.
 *
 * Exported for injection into `AssistantService` and `McpService`, which live
 * in modules that import this one.
 */
@Module({
  imports: [PrismaModule],
  providers: [ProvenanceService],
  exports: [ProvenanceService],
})
export class FeedbackCoreModule {}
