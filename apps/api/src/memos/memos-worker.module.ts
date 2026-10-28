import { Module } from '@nestjs/common';
import { AgentQueueModule } from '../agents/agent-queue.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { MemosQueueModule } from './memos-queue.module.js';
import { MemoRetentionSweeper } from './memo-retention.sweeper.js';
import { MemosProcessor } from './memos.processor.js';
import { TranscriptionClient } from './transcription.client.js';

/**
 * Consumer side (#551) — imported ONLY by worker.module.ts. In AppModule it
 * would make the API process start transcribing.
 */
@Module({
  imports: [PrismaModule, StorageModule, AiCoreModule, AgentQueueModule, MemosQueueModule],
  providers: [MemosProcessor, TranscriptionClient, MemoRetentionSweeper],
})
export class MemosWorkerModule {}
