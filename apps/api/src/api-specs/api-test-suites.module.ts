import { Module } from '@nestjs/common';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ApiSpecsCoreModule } from './api-specs-core.module.js';
import { ApiTestSuiteRequestsService } from './api-test-suite-requests.service.js';

/**
 * QA test suites as a caller asks for them (#468, #483): read, export, bind,
 * rank, Generate. Controller-free, so the REST routes (ApiSpecsModule) and
 * the MCP tools share it; API-side only, since Generate queues a tester run
 * the worker executes.
 */
@Module({
  imports: [PrismaModule, ApiSpecsCoreModule, AiCoreModule, AgentCoreModule, AgentQueueModule],
  providers: [ApiTestSuiteRequestsService],
  exports: [ApiTestSuiteRequestsService],
})
export class ApiTestSuitesModule {}
