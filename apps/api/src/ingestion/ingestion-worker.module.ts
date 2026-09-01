import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { IngestionModule } from './ingestion.module.js';
import { IngestionProcessor } from './ingestion.processor.js';
import { OutboxSweeper } from './outbox.sweeper.js';

/** Consumer side — imported ONLY by the worker entrypoint (worker.module.ts). */
@Module({
  imports: [IngestionModule, StorageModule, GraphModule, EmbeddingModule, ExtractionModule],
  providers: [IngestionProcessor, OutboxSweeper],
})
export class IngestionWorkerModule {}
