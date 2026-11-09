import { Module } from '@nestjs/common';
import { IngestionModule } from './ingestion.module.js';
import { IngestionAdminService } from './ingestion-admin.service.js';

/** The reindex service without its controller: MCP's knowledge_ingest needs it in the stdio process (#822). */
@Module({
  imports: [IngestionModule],
  providers: [IngestionAdminService],
  exports: [IngestionAdminService],
})
export class IngestionAdminCoreModule {}
