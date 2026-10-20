import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiConfigService } from './ai-config.service.js';
import { AiProvidersService } from './ai-providers.service.js';
import { AiUsageService } from './ai-usage.service.js';
import { AiSkillsService } from './ai-skills.service.js';
import { AgentLearningsService } from './agent-learnings.service.js';
import { SourcePolicyService } from './source-policy.service.js';
import { AgentOutcomesService } from './agent-outcomes.service.js';

/**
 * Provider resolution and token accounting, with no controllers and no auth
 * dependencies — so the worker can import it.
 *
 * The split exists because relation extraction runs in the worker but is
 * routed by the same per-workspace provider profiles the API uses
 * (docs/features/12). Same shape as EventsModule / EventsApiModule: the
 * publisher half is worker-safe, the controller half is not.
 *
 * SourcePolicyService is here because AiConfigService needs it to resolve the
 * clamped web-access mode, and because the web tools must reach the same
 * decision function the settings page writes rows for (docs/features/25).
 *
 * AiSkillsService lives here for the same reason (it needs only Prisma): a
 * workflow step and a background agent both carry `skillIds`, and rendering
 * them anywhere but through this service is how feature 17 ended up with a
 * second copy of the `<skills>` block. AgentLearningsService (#70) sits beside
 * it for the same reason: the chat turn, a mention reply and every background
 * executor render one "team guidance" block. AgentOutcomesService (#305) is
 * Prisma-only too: the API's ledger route and the learner process's
 * before/after check read the same counts.
 */
@Module({
  imports: [PrismaModule],
  providers: [AiProvidersService, AiConfigService, AiUsageService, AiSkillsService, AgentLearningsService, SourcePolicyService, AgentOutcomesService],
  exports: [AiProvidersService, AiConfigService, AiUsageService, AiSkillsService, AgentLearningsService, SourcePolicyService, AgentOutcomesService],
})
export class AiCoreModule {}
