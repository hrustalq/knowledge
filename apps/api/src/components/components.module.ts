import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ComponentDraftSweeper } from './component-draft.sweeper.js';
import { ComponentDraftsModule } from './component-drafts.module.js';
import { ComponentsCoreModule } from './components-core.module.js';
import { CodeUsagesController, ComponentDraftsController, ComponentsController } from './components.controller.js';

/**
 * The REST surface for component declarations and their usages (#236). API-only: it carries controllers,
 * and the sweeper that opens a drafted component page as a merge request through `AgentFindingsService`
 * (the `DriftModule` precedent).
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, AiModule, ComponentsCoreModule, ComponentDraftsModule, PermissionsCoreModule],
  controllers: [ComponentsController, CodeUsagesController, ComponentDraftsController],
  providers: [ComponentDraftSweeper],
  exports: [ComponentsCoreModule, ComponentDraftsModule],
})
export class ComponentsModule {}
