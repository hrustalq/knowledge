import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * API-only: the controller's guards need AccessService, which the worker and
 * MCP contexts do not have. Same rule as GraphQueryModule / IngestionAdminModule
 * — never import this into WorkerModule.
 */
@Module({
  imports: [PrismaModule, StorageModule, ActivityModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
