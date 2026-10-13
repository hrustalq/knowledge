import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ExportCoreModule } from './export-core.module.js';
import { ExportController } from './export.controller.js';
import { ExportSweeper } from './export.sweeper.js';

/**
 * API-only: the export routes and the sweeper that deletes expired files
 * (docs/features/45). Never import into WorkerModule; the worker's half is
 * ExportWorkerModule.
 */
@Module({
  imports: [PrismaModule, StorageModule, ExportCoreModule],
  controllers: [ExportController],
  providers: [ExportSweeper],
})
export class ExportModule {}
