import { Module } from '@nestjs/common';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ProjectsCoreModule } from './projects-core.module.js';
import { BlueprintsController } from '../blueprints/blueprints.controller.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectOverviewService } from './project-overview.service.js';
import { ProjectCascadeService } from './project-cascade.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { ProjectScaffoldCoreModule } from './project-scaffold-core.module.js';
import { BlueprintDeriveService } from '../blueprints/blueprint-derive.service.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AssistantReadToolsModule } from '../assistant/assistant-read-tools.module.js';
import { BlueprintGenerateService } from '../blueprints/blueprint-generate.service.js';

/**
 * Workspace > Project > Document — the organizational layer above pages.
 * API-only: MCP and the worker import ProjectsCoreModule (and MCP
 * ProjectScaffoldCoreModule) instead (#822).
 */
@Module({
  // Storage/graph/fulltext are here for the cascade teardown only.
  // Documents, templates and AI skills write a scaffold's pages and conventions (#716).
  imports: [
    ProjectsCoreModule,
    StorageModule,
    GraphModule,
    FulltextModule,
    PermissionsCoreModule,
    DocumentsCoreModule,
    TemplatesCoreModule,
    AiCoreModule,
    // The scaffolder's calls (#716): derive's one, and Describe it's read-only tool loop. All controller-free.
    AgentCoreModule,
    AssistantClientModule,
    AssistantReadToolsModule,
    // Blueprints and the scaffold write, shared with MCP (#822).
    ProjectScaffoldCoreModule,
  ],
  controllers: [ProjectsController, BlueprintsController],
  providers: [ProjectOverviewService, ProjectCascadeService, BlueprintDeriveService, BlueprintGenerateService],
  // The cascade is exported because connector revert reuses it to undo a page
  // this product otherwise has no way to delete (docs/features/26). Blueprints
  // and scaffold back knowledge_list_blueprints / knowledge_scaffold_project (#716).
  exports: [ProjectsCoreModule, ProjectCascadeService, ProjectScaffoldCoreModule],
})
export class ProjectsModule {}
