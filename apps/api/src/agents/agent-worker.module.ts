import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { EventsModule } from '../events/events.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AssistantReadToolsModule } from '../assistant/assistant-read-tools.module.js';
import { WebResearchModule } from '../assistant/web-research.module.js';
import { CodeResearchModule } from '../connectors/code-research/code-research.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { GlossaryCoreModule } from '../glossary/glossary-core.module.js';
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
 * `AssistantClientModule` is imported rather than `AssistantModule`, which
 * pulls `DocumentsModule` — the same move `WorkflowWorkerModule` makes, and for
 * the same reason. `DocumentsCoreModule` and `GlossaryCoreModule` are the
 * worker-safe halves the reviewer and glossarist executors read pages through.
 * `AssistantReadToolsModule` is what gives a background agent a tool loop at
 * all. Until it existed the cartographer answered from one pre-baked prompt,
 * because the only tool implementation lived in `AssistantToolsService`, which
 * injects StorageService, MergeRequestsService and the rest of the API-only
 * half and therefore cannot load here.
 *
 * Note what is still deliberately absent: `AssistantToolsService` and anything
 * that can write. The read module reaches only search, documents, prisma and
 * access — a background agent proposes; publishing stays on the API side
 * (feature 17).
 */
@Module({
  imports: [
    PrismaModule,
    GraphModule,
    EventsModule,
    AiCoreModule,
    AuthCoreModule,
    AgentCoreModule,
    AgentQueueModule,
    AssistantClientModule,
    AssistantReadToolsModule,
    // No runnable agent reaches the web yet — the research loop that will is
    // still open (docs/features/29). This is imported anyway, and it is not
    // dead wiring: Nest constructs an imported module's providers at boot, so
    // the worker builds WebResearchService on every start. The day somebody
    // gives that service an API-only dependency, the worker fails loudly at
    // boot rather than silently at the first tool call in a background run —
    // which is exactly how it came to be unreachable from here in the first
    // place.
    WebResearchModule,
    // The repository tools (docs/features/31), imported for the same canary
    // reason — and, unlike the web pair, about to be used: the archaeologist
    // reads a codebase from here.
    CodeResearchModule,
    DocumentsCoreModule,
    GlossaryCoreModule,
  ],
  providers: [AgentExecutor, AgentProcessor, AgentScheduleSweeper],
})
export class AgentWorkerModule {}
