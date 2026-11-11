import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { MemoPublishSweeper } from './memo-publish.sweeper.js';
import { MemoTriageSweeper } from './memo-triage.sweeper.js';
import { MemosQueueModule } from './memos-queue.module.js';
import { MemosCoreModule } from './memos-core.module.js';
import { MemosController } from './memos.controller.js';

/**
 * Memos (#551), API side. Controller-bearing, so never imported by the
 * worker; `MemoPublishSweeper` lives here because opening a merge request
 * needs `AgentFindingsService`, whose module carries controllers.
 */
@Module({
  imports: [PrismaModule, MemosCoreModule, MemosQueueModule, AiModule, AssistantClientModule, PermissionsCoreModule, AuthCoreModule, EventsModule, NotificationsCoreModule],
  controllers: [MemosController],
  providers: [MemoPublishSweeper, MemoTriageSweeper],
})
export class MemosModule {}
