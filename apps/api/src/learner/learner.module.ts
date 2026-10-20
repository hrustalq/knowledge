import { Module } from '@nestjs/common';
import { BootstrapModule } from '../config/bootstrap.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { LearnerService } from './learner.service.js';
import { LearnerTicker } from './learner.ticker.js';

/**
 * Root module of the fifth entrypoint, `learner.main.ts` (#305): the learner
 * process, which clusters dismissed findings into proposed learnings and
 * checks whether active ones helped.
 *
 * Deliberately small. It loads no controller, gateway, processor or sweeper
 * of the other processes — `apps/api/.dependency-cruiser.cjs` enforces that
 * the way it does for the worker and MCP — and no Redis or BullMQ wiring: it
 * reads Postgres, embeds through the configured provider and calls one model
 * through `AssistantClient`. Page visibility is the plain `acl-read.ts` +
 * `access-scope.ts` functions rather than `PermissionsCoreModule`, whose event
 * and mail publishers a reader has no use for.
 */
@Module({
  imports: [BootstrapModule, PrismaModule, AiCoreModule, AgentCoreModule, AssistantClientModule, EmbeddingModule],
  providers: [LearnerService, LearnerTicker],
})
export class LearnerModule {}
