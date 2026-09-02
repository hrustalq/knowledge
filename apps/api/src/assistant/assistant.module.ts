import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';
import { AssistantClient } from './assistant.client.js';
import { AssistantToolsService } from './assistant.tools.js';
import { AssistantService } from './assistant.service.js';
import { AssistantThreadsService } from './assistant-threads.service.js';
import { AssistantController } from './assistant.controller.js';

@Module({
  imports: [SearchModule, DocumentsModule, StorageModule, EventsModule],
  controllers: [AssistantController],
  providers: [AssistantClient, AssistantToolsService, AssistantService, AssistantThreadsService],
})
export class AssistantModule {}
