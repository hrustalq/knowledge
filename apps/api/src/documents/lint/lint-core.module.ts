import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../../agents/agent-core.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { LintChecksService } from './lint-checks.service.js';

/**
 * Merge request checks with no controller and no AccessService (#74): the lint
 * policy and the check reads. A leaf over Prisma and the agent registry, so
 * DocumentsModule can import it for the merge gate (phase 3) without a cycle.
 * The trigger and the publisher are LintModule's — API-only.
 */
@Module({
  imports: [PrismaModule, AgentCoreModule],
  providers: [LintChecksService],
  exports: [LintChecksService],
})
export class LintCoreModule {}
