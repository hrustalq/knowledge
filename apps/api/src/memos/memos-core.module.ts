import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { MemosService } from './memos.service.js';

/** Memos (#551), controller-free: the REST controller and the MCP tools read through it. */
@Module({
  imports: [PrismaModule, StorageModule, PermissionsCoreModule, AiCoreModule],
  providers: [MemosService],
  exports: [MemosService],
})
export class MemosCoreModule {}
