import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { MemosCoreModule } from '../memos/memos-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PlaudCoreModule } from './plaud-core.module.js';
import { PlaudImportSweeper } from './plaud-import.sweeper.js';
import { PlaudImportsService } from './plaud-imports.service.js';
import { PlaudController } from './plaud.controller.js';

/**
 * Plaud (#864), API side. Controller-bearing, so never imported by the
 * worker; the queue and its sweeper live here because an import is the
 * person's act and needs their principal.
 */
@Module({
  imports: [PrismaModule, PlaudCoreModule, MemosCoreModule, AuthCoreModule, EventsModule, NotificationsCoreModule],
  controllers: [PlaudController],
  providers: [PlaudImportsService, PlaudImportSweeper],
})
export class PlaudModule {}
