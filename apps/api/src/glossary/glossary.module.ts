import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { AssistantModule } from '../assistant/assistant.module.js';
import { AiModule } from '../ai/ai.module.js';
import { GlossaryController } from './glossary.controller.js';
import { GlossaryService } from './glossary.service.js';

/**
 * Glossary (docs/features/14). API-only — the controller depends on the global
 * auth guards, so this stays out of WorkerModule and McpModule (same rationale
 * as GraphQueryModule).
 *
 * AssistantModule and AiModule are imported for the one AI operation here
 * (`suggest`): the client that talks to the provider, plus the per-workspace
 * config and the token budget it has to respect.
 */
@Module({
  imports: [PrismaModule, ActivityModule, DocumentsModule, ProjectsModule, AssistantModule, AiModule],
  controllers: [GlossaryController],
  providers: [GlossaryService],
  exports: [GlossaryService],
})
export class GlossaryModule {}
