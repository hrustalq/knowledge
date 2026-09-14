import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { WorkflowQueueModule } from './workflow-queue.module.js';
import { WorkflowRunnerService } from './workflow-runner.service.js';

/**
 * Controller-free half of the workflow engine (docs/features/17), imported by
 * both `WorkflowsModule` (API) and `WorkflowWorkerModule` (worker) so a run is
 * advanced through exactly the same code in either process — the same split as
 * `AiCoreModule` under `AiModule`.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule, WorkflowQueueModule],
  providers: [WorkflowRunnerService],
  exports: [WorkflowRunnerService, WorkflowQueueModule],
})
export class WorkflowCoreModule {}
