import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AiModule } from '../ai/ai.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ProjectsCoreModule } from '../projects/projects-core.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { ConfiguratorController } from './configurator.controller.js';
import { ConfiguratorService } from './configurator.service.js';
import { ConfigurationApplyService } from './configuration-apply.service.js';

/** The configurator (#1250). API-only: a controller, and applying is a person's act. */
@Module({
  imports: [PrismaModule, ActivityModule, AiModule, AssistantClientModule, PermissionsCoreModule, ProjectsCoreModule, ConnectorsCoreModule],
  controllers: [ConfiguratorController],
  providers: [ConfiguratorService, ConfigurationApplyService],
})
export class ConfiguratorModule {}
