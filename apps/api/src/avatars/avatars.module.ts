import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AvatarsController } from './avatars.controller.js';
import { AvatarsService } from './avatars.service.js';

/**
 * API-only: the controller's guards need AccessService, which the worker and
 * MCP contexts do not have. The same rule as AttachmentsModule and
 * GraphQueryModule — never import this into WorkerModule.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  controllers: [AvatarsController],
  providers: [AvatarsService],
  exports: [AvatarsService],
})
export class AvatarsModule {}
