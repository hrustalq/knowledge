import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ExportBuildService } from './export-build.service.js';
import { ExportCoreModule } from './export-core.module.js';
import { ExportRenderClient } from './export-render.client.js';
import { ExportProcessor } from './export.processor.js';
import { GotenbergClient } from './gotenberg.client.js';

/**
 * Consumer side of exports (docs/features/45) — imported ONLY by the worker
 * entrypoint (worker.module.ts). Importing this into AppModule would make the
 * API process start building exports.
 */
@Module({
  imports: [PrismaModule, StorageModule, EventsModule, ExportCoreModule],
  providers: [ExportBuildService, ExportProcessor, ExportRenderClient, GotenbergClient],
})
export class ExportWorkerModule {}
