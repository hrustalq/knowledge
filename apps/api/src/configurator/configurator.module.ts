import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AiModule } from '../ai/ai.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { WorkflowCoreModule } from '../workflows/workflow-core.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { VerificationPolicyModule } from '../verification/verification-policy.module.js';
import { ApiRunnerCoreModule } from '../api-specs/api-runner-core.module.js';
import { LintCoreModule } from '../documents/lint/lint-core.module.js';
import { WorkItemHandoffModule } from '../connectors/handoff/work-item-handoff.module.js';
import { ReadCacheCoreModule } from '../cache/read-cache.module.js';
import { ConfiguratorController } from './configurator.controller.js';
import { ConfiguratorService } from './configurator.service.js';
import { ConfigurationApplyService } from './configuration-apply.service.js';
import { ProjectSettingChanges } from './project-setting-changes.js';

/** The configurator (#1250). API-only: a controller, and applying is a person's act. */
@Module({
  imports: [
    PrismaModule,
    ActivityModule,
    AiModule,
    AssistantClientModule,
    PermissionsCoreModule,
    ProjectsCoreModule,
    ConnectorsCoreModule,
    WorkflowCoreModule,
    TemplatesCoreModule,
    // Project settings (#1313): each through its own route's service.
    VerificationPolicyModule,
    ApiRunnerCoreModule,
    LintCoreModule,
    WorkItemHandoffModule,
    ReadCacheCoreModule,
  ],
  controllers: [ConfiguratorController],
  providers: [ConfiguratorService, ConfigurationApplyService, ProjectSettingChanges],
})
export class ConfiguratorModule {}
