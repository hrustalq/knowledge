import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ApiSpecsService } from './api-specs.service.js';

/**
 * API spec parsing and projection (#78), with no controller, so both processes
 * load it: DocumentsService refuses an invalid spec at finalize, and the
 * ingestion worker projects a valid one. A leaf — Prisma and config only — so
 * DocumentsCoreModule can import it without a cycle. The read API that comes
 * later lives in an API-only ApiSpecsModule beside this one.
 */
@Module({
  imports: [PrismaModule],
  providers: [ApiSpecsService],
  exports: [ApiSpecsService],
})
export class ApiSpecsCoreModule {}
