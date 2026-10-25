import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { DecisionClientModule } from '../assistant/decision-client.module.js';
import { CapturesCoreModule } from '../captures/captures-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { SearchCoreModule } from '../search/search-core.module.js';
import { HarvestService } from './harvest.service.js';

/**
 * `HarvestService` on its own (#382): chat threads (ChatModule) and resolved
 * tracker or help-desk items (ConnectorsModule) are harvested by the one
 * service, and neither module should load the other's controllers to reach
 * it. Controller-free, but API-side only by use: a harvest is attributed to a
 * person, so only API processes import it.
 */
@Module({
  imports: [
    PrismaModule,
    AgentCoreModule,
    AiCoreModule,
    AssistantClientModule,
    // The "settles nothing" pre-filter (#530).
    DecisionClientModule,
    CapturesCoreModule,
    PermissionsCoreModule,
    SearchCoreModule,
  ],
  providers: [HarvestService],
  exports: [HarvestService],
})
export class HarvestCoreModule {}
