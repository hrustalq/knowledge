import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { MemoPublishSweeper } from './memo-publish.sweeper.js';
import { MemosCoreModule } from './memos-core.module.js';
import { MemosController } from './memos.controller.js';

/**
 * Memos (#551), API side. Controller-bearing, so never imported by the
 * worker; `MemoPublishSweeper` lives here because opening a merge request
 * needs `AgentFindingsService`, whose module carries controllers.
 */
@Module({
  imports: [PrismaModule, MemosCoreModule, AiModule, AuthCoreModule, EventsModule, NotificationsCoreModule],
  controllers: [MemosController],
  providers: [MemoPublishSweeper],
})
export class MemosModule {}
