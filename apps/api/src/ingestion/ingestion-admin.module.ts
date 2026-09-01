import { Module } from '@nestjs/common';
import { IngestionModule } from './ingestion.module.js';
import { IngestionAdminService } from './ingestion-admin.service.js';
import { IngestionController } from './ingestion.controller.js';

/**
 * API-side ingestion admin surface (Phase 5). Separate from IngestionModule
 * so the worker context never instantiates the controller and its auth
 * dependencies; imported by AppModule (HTTP) and McpModule (knowledge_ingest).
 */
@Module({
  imports: [IngestionModule],
  controllers: [IngestionController],
  providers: [IngestionAdminService],
  exports: [IngestionAdminService],
})
export class IngestionAdminModule {}
