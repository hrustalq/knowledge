import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { BlueprintsService } from '../blueprints/blueprints.service.js';
import { MethodologyMaterializerService } from '../blueprints/methodology-materializer.service.js';
import { WorkflowCoreModule } from '../workflows/workflow-core.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { ProjectsCoreModule } from './projects-core.module.js';
import { ProjectScaffoldService } from './project-scaffold.service.js';
import { ProjectMethodologyService } from './project-methodology.service.js';

/**
 * Blueprints and the scaffold write (#716), controller-free: they back
 * knowledge_list_blueprints / knowledge_scaffold_project in the stdio MCP
 * process too (#822). Derive and Describe it stay in ProjectsModule.
 */
@Module({
  imports: [ProjectsCoreModule, DocumentsCoreModule, TemplatesCoreModule, AiCoreModule, PermissionsCoreModule, WorkflowCoreModule, AgentCoreModule],
  providers: [BlueprintsService, MethodologyMaterializerService, ProjectScaffoldService, ProjectMethodologyService],
  exports: [BlueprintsService, MethodologyMaterializerService, ProjectScaffoldService, ProjectMethodologyService],
})
export class ProjectScaffoldCoreModule {}
