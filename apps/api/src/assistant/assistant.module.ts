import { forwardRef, Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { SearchModule } from '../search/search.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';
import { AssistantClientModule } from './assistant-client.module.js';
import { AssistantReadToolsModule } from './assistant-read-tools.module.js';
import { AssistantToolsService } from './assistant.tools.js';
import { WebResearchModule } from './web-research.module.js';
import { AssistantService } from './assistant.service.js';
import { AssistantThreadsService } from './assistant-threads.service.js';
import { AssistantController } from './assistant.controller.js';
import { AiModule } from '../ai/ai.module.js';

// AiModule is a forwardRef because the dependency genuinely runs both ways:
// a turn needs the workspace's AI config, and the settings page's "Test
// connection" needs AssistantClient. AssistantClientModule is re-exported for
// that.
@Module({
  imports: [
    AgentCoreModule,
    // Imported directly rather than reached through the AiModule forwardRef:
    // the web tools need AiConfigService and SourcePolicyService, both
    // controller-free, and a forwardRef'd dependency would need @Inject at
    // every injection site for no gain (docs/features/25).
    AiCoreModule,
    AssistantClientModule,
    // The read half of the tool surface, which AssistantToolsService delegates
    // to and the agent worker loads on its own (see the module's own note).
    AssistantReadToolsModule,
    SearchModule,
    DocumentsModule,
    StorageModule,
    EventsModule,
    // The web tools moved into a controller-free module of their own so the
    // agent worker can construct them too (docs/features/29). Reached exactly
    // as before from here — AssistantToolsService still injects the service.
    WebResearchModule,
    forwardRef(() => AiModule),
  ],
  controllers: [AssistantController],
  providers: [AssistantToolsService, AssistantService, AssistantThreadsService],
  // Re-exported rather than re-provided, so the API and the worker share one
  // client with one SDK cache.
  exports: [AssistantClientModule],
})
export class AssistantModule {}
