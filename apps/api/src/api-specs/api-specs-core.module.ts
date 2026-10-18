import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { ApiSpecDiffService } from './api-spec-diff.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';
import { ApiSpecsService } from './api-specs.service.js';

/**
 * API spec parsing and projection (#78), with no controller, so both processes
 * load it: DocumentsService refuses an invalid spec at finalize, and the
 * ingestion worker projects a valid one. The reads (`ApiSpecReadService`) are
 * here too, so the MCP tools can inject them, and so is the classified diff
 * the merge gate reads (phase 6); the routes are the API-only
 * ApiSpecsModule. A leaf — Prisma, storage and config — so DocumentsCoreModule
 * imports it without a cycle.
 */
@Module({
  imports: [PrismaModule, StorageModule],
  providers: [ApiSpecsService, ApiSpecReadService, ApiSpecDiffService],
  exports: [ApiSpecsService, ApiSpecReadService, ApiSpecDiffService],
})
export class ApiSpecsCoreModule {}
