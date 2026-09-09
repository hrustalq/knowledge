import { forwardRef, Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { SearchModule } from '../search/search.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';
import { AssistantClientModule } from './assistant-client.module.js';
import { AssistantToolsService } from './assistant.tools.js';
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
    AssistantClientModule,
    SearchModule,
    DocumentsModule,
    StorageModule,
    EventsModule,
    forwardRef(() => AiModule),
  ],
  controllers: [AssistantController],
  providers: [AssistantToolsService, AssistantService, AssistantThreadsService],
  // Re-exported rather than re-provided, so the API and the worker share one
  // client with one SDK cache.
  exports: [AssistantClientModule],
})
export class AssistantModule {}
