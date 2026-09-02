import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { AssistantService } from './assistant.service.js';
import { AssistantController } from './assistant.controller.js';

@Module({
  imports: [SearchModule, DocumentsModule],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
