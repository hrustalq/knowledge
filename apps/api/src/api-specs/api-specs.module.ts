import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ApiDriftCheckService } from './api-drift-check.service.js';
import { ApiOperationsController, ApiSettingsController, ApiSpecsController, QaController, TestFixturesController } from './api-specs.controller.js';
import { ApiSpecsCoreModule } from './api-specs-core.module.js';
import { ApiTestSuitesModule } from './api-test-suites.module.js';
import { ApiRunnerCoreModule } from './api-runner-core.module.js';

/**
 * The REST surface of API spec documents (#78). API-only: it carries
 * controllers. The try-it proxy and its settings live in ApiRunnerCoreModule
 * (#483), because the QA server runner in the worker sends through it too.
 * The drift check only queues a sentinel run (phase 8); the worker compares.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, PermissionsCoreModule, ApiSpecsCoreModule, ApiTestSuitesModule, ApiRunnerCoreModule, AiCoreModule, AgentCoreModule, AgentQueueModule],
  controllers: [ApiSpecsController, ApiOperationsController, ApiSettingsController, TestFixturesController, QaController],
  providers: [ApiDriftCheckService],
  exports: [ApiSpecsCoreModule],
})
export class ApiSpecsModule {}
