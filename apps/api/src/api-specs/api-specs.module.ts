import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { PublicStore } from '../public/public-store.js';
import { ApiDriftCheckService } from './api-drift-check.service.js';
import { ApiSettingsService } from './api-settings.service.js';
import { ApiOperationsController, ApiSettingsController, ApiSpecsController } from './api-specs.controller.js';
import { ApiSpecsCoreModule } from './api-specs-core.module.js';
import { ApiTestSuiteRequestsService } from './api-test-suite-requests.service.js';
import { ApiTryService } from './api-try.service.js';

/**
 * The REST surface of API spec documents (#78). API-only: it carries
 * controllers, and the try-it proxy, which nothing in the worker may reach.
 * The drift check only queues a sentinel run (phase 8); the worker compares.
 * Its own lazy Redis counter: the rate limiter is the one PublicModule uses,
 * provided here rather than imported, since that module carries controllers.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, PermissionsCoreModule, ApiSpecsCoreModule, AiCoreModule, AgentCoreModule, AgentQueueModule],
  controllers: [ApiSpecsController, ApiOperationsController, ApiSettingsController],
  providers: [ApiSettingsService, ApiTryService, ApiDriftCheckService, ApiTestSuiteRequestsService, PublicStore, PublicRateLimiter],
  exports: [ApiSpecsCoreModule],
})
export class ApiSpecsModule {}
