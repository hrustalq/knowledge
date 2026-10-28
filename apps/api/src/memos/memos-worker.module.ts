import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { MemosQueueModule } from './memos-queue.module.js';
import { MemosProcessor } from './memos.processor.js';
import { TranscriptionClient } from './transcription.client.js';

/**
 * Consumer side (#551) — imported ONLY by worker.module.ts. In AppModule it
 * would make the API process start transcribing.
 */
@Module({
  imports: [PrismaModule, StorageModule, AiCoreModule, MemosQueueModule],
  providers: [MemosProcessor, TranscriptionClient],
})
export class MemosWorkerModule {}
