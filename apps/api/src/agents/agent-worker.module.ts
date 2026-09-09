import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { EventsModule } from '../events/events.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AgentCoreModule } from './agent-core.module.js';
import { AgentQueueModule } from './agent-queue.module.js';
import { AgentExecutor } from './agent.executor.js';
import { AgentProcessor } from './agent.processor.js';
import { AgentScheduleSweeper } from './agent-schedule.sweeper.js';

/**
 * Worker-only half of the agents layer (docs/features/20) — imported by
 * `WorkerModule` alone, or the API process would start consuming agent jobs.
 *
 * `AuthCoreModule` is what this feature needed the auth split for: a background
 * run authorises through the very `AccessService.requireRole` an HTTP request
 * uses, rather than a weakened copy or an ambient identity.
 *
 * `AssistantClient` is provided directly rather than by importing
 * `AssistantModule`, which pulls `DocumentsModule` — the same move
 * `WorkflowWorkerModule` makes, and for the same reason. Note what is
 * deliberately absent: `AssistantToolsService` and anything that can write. A
 * background agent proposes; publishing stays on the API side (feature 17).
 */
@Module({
  imports: [PrismaModule, GraphModule, EventsModule, AiCoreModule, AuthCoreModule, AgentCoreModule, AgentQueueModule],
  providers: [AssistantClient, AgentExecutor, AgentProcessor, AgentScheduleSweeper],
})
export class AgentWorkerModule {}
