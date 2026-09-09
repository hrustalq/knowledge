import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { GlossaryService } from './glossary.service.js';

/**
 * Controller-free half of the glossary (docs/features/14), so the background
 * glossarist can run the very same `suggest` the settings page runs
 * (docs/features/20). A second copy of that prompt in the worker is exactly the
 * duplication feature 20 was written against.
 *
 * Every dependency resolves to a Core module: the service itself never reaches
 * for AccessService, and the API-side authorisation stays in the controller
 * where it belongs. `GlossaryModule` imports this and re-exports it, so no
 * existing `imports: [GlossaryModule]` changes.
 */
@Module({
  imports: [
    PrismaModule,
    ActivityCoreModule,
    DocumentsCoreModule,
    ProjectsCoreModule,
    AssistantClientModule,
    AiCoreModule,
    AgentCoreModule,
  ],
  providers: [GlossaryService],
  exports: [GlossaryService],
})
export class GlossaryCoreModule {}
