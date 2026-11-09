import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { BlueprintsService } from '../blueprints/blueprints.service.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { ProjectsCoreModule } from './projects-core.module.js';
import { ProjectScaffoldService } from './project-scaffold.service.js';

/**
 * Blueprints and the scaffold write (#716), controller-free: they back
 * knowledge_list_blueprints / knowledge_scaffold_project in the stdio MCP
 * process too (#822). Derive and Describe it stay in ProjectsModule.
 */
@Module({
  imports: [ProjectsCoreModule, DocumentsCoreModule, TemplatesCoreModule, AiCoreModule, PermissionsCoreModule],
  providers: [BlueprintsService, ProjectScaffoldService],
  exports: [BlueprintsService, ProjectScaffoldService],
})
export class ProjectScaffoldCoreModule {}
