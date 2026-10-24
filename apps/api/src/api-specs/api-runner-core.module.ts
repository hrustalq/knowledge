import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { PublicStore } from '../public/public-store.js';
import { ApiSettingsService } from './api-settings.service.js';
import { ApiSpecsCoreModule } from './api-specs-core.module.js';
import { ApiTestEnvironmentsService } from './api-test-environments.service.js';
import { ApiTestRunQueueModule } from './api-test-run-queue.module.js';
import { ApiTestRunsService } from './api-test-runs.service.js';
import { ApiTryService } from './api-try.service.js';

/**
 * Sending to an API server, with no controller (#483, phase 5): the try-it
 * proxy, the workspace settings that bound it, and the QA server runner's
 * environments and run records. Here rather than in ApiSpecsModule because the
 * worker sends too — one `ApiTryService` is the only egress path, so a server
 * run reaches exactly what the proxy reaches. Its own lazy Redis counter, as
 * ApiSpecsModule had: the rate limiter is the one PublicModule uses, provided
 * here rather than imported, since that module carries controllers.
 */
@Module({
  imports: [PrismaModule, AiCoreModule, AuthCoreModule, ApiSpecsCoreModule, ApiTestRunQueueModule],
  providers: [ApiSettingsService, ApiTryService, PublicStore, PublicRateLimiter, ApiTestEnvironmentsService, ApiTestRunsService],
  exports: [ApiSettingsService, ApiTryService, ApiTestEnvironmentsService, ApiTestRunsService],
})
export class ApiRunnerCoreModule {}
