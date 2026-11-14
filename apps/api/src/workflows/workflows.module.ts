import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { WorkflowCoreModule } from './workflow-core.module.js';
import { WorkflowsController } from './workflows.controller.js';
import { DocumentWorkflowsController } from './document-workflows.controller.js';
import { WorkflowMaterializerService } from './workflow-materializer.service.js';
import { WorkflowDraftService } from './workflow-draft.service.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';

/**
 * Dynamic document workflows (docs/features/17). Stays out of WorkerModule —
 * the controllers depend on the global auth guards (same rationale as
 * GraphQueryModule and ImportModule).
 *
 * MCP imports `WorkflowCoreModule` (which holds `WorkflowsService`) for
 * `knowledge_list/start_workflow` and `knowledge_get_workflow_run`, never this
 * module (#822). The materialize sweeper still lives in
 * `WorkflowMaterializeModule`: an earlier version of this module was imported
 * by MCP, and the sweeper's 5-second timer ran in every stdio process.
 *
 * DocumentsModule is imported for the one thing the worker cannot do: writing
 * an approved draft into the page tree.
 *
 * The three AI imports serve the architect alone (`POST /v1/workflows/draft`).
 * They are the Core halves deliberately — the wizard needs to resolve an agent,
 * call a provider and bill the call, and nothing more; importing AssistantModule
 * for its client would pull DocumentsModule back in through a second door.
 */
@Module({
  imports: [
    PrismaModule,
    ActivityModule,
    DocumentsModule,
    ProjectsModule,
    WorkflowCoreModule,
    AgentCoreModule,
    AiCoreModule,
    AssistantClientModule,
    TemplatesCoreModule,
    PermissionsCoreModule,
  ],
  controllers: [WorkflowsController, DocumentWorkflowsController],
  providers: [WorkflowMaterializerService, WorkflowDraftService],
  exports: [WorkflowCoreModule, WorkflowMaterializerService],
})
export class WorkflowsModule {}
