import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { EventsModule } from '../events/events.module.js';
import { ImportQueueModule } from './import-queue.module.js';
import { ImportProcessor } from './import.processor.js';
import { ParsersModule } from './parsers/parsers.module.js';

/**
 * Consumer side — imported ONLY by the worker entrypoint (worker.module.ts),
 * exactly like IngestionWorkerModule. Importing this into AppModule would make
 * the API process start consuming parse jobs.
 */
@Module({
  imports: [ImportQueueModule, StorageModule, EventsModule, ParsersModule],
  providers: [ImportProcessor],
})
export class ImportWorkerModule {}
