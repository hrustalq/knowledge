import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { FulltextModule } from '../fulltext/fulltext.module.js';
import { IngestionModule } from './ingestion.module.js';
import { IngestionProcessor } from './ingestion.processor.js';
import { OutboxSweeper } from './outbox.sweeper.js';
import { StaleSweeper } from './stale.sweeper.js';

/** Consumer side — imported ONLY by the worker entrypoint (worker.module.ts). */
@Module({
  imports: [IngestionModule, StorageModule, GraphModule, EmbeddingModule, ExtractionModule, FulltextModule],
  providers: [IngestionProcessor, OutboxSweeper, StaleSweeper],
})
export class IngestionWorkerModule {}
