import { forwardRef, Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';
import { AssistantClient } from './assistant.client.js';
import { AssistantToolsService } from './assistant.tools.js';
import { AssistantService } from './assistant.service.js';
import { AssistantThreadsService } from './assistant-threads.service.js';
import { AssistantController } from './assistant.controller.js';
import { AiModule } from '../ai/ai.module.js';

// AiModule is a forwardRef because the dependency genuinely runs both ways:
// a turn needs the workspace's AI config, and the settings page's "Test
// connection" needs AssistantClient. AssistantClient is exported for that.
@Module({
  imports: [SearchModule, DocumentsModule, StorageModule, EventsModule, forwardRef(() => AiModule)],
  controllers: [AssistantController],
  providers: [AssistantClient, AssistantToolsService, AssistantService, AssistantThreadsService],
  exports: [AssistantClient],
})
export class AssistantModule {}
