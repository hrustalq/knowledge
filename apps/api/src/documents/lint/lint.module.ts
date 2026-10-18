import { Module } from '@nestjs/common';
import { ActivityModule } from '../../activity/activity.module.js';
import { AgentQueueModule } from '../../agents/agent-queue.module.js';
import { AiCoreModule } from '../../ai/ai-core.module.js';
import { EventsModule } from '../../events/events.module.js';
import { PermissionsCoreModule } from '../../permissions/permissions-core.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { LintController } from './lint.controller.js';
import { LintCoreModule } from './lint-core.module.js';
import { LintPublishSweeper } from './lint-publish.sweeper.js';
import { LintTriggerSweeper } from './lint-trigger.sweeper.js';

/**
 * The API half of the merge request style lint (#74, phase 2): the trigger
 * that queues a `linter` run per source head, the publisher that turns a
 * finished run into review threads, and their routes. Imported by `AppModule`
 * alone — the trigger rehydrates the author through AccessService, and the
 * publisher writes discussions attributed to a person, which is the API's job
 * (the worker generates, the API publishes). The run itself is the worker's:
 * AgentExecutor's `linter` case.
 */
@Module({
  imports: [PrismaModule, LintCoreModule, AiCoreModule, AgentQueueModule, EventsModule, ActivityModule, PermissionsCoreModule],
  controllers: [LintController],
  providers: [LintTriggerSweeper, LintPublishSweeper],
})
export class LintModule {}
