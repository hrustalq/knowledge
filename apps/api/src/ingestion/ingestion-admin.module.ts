import { Module } from '@nestjs/common';
import { IngestionAdminCoreModule } from './ingestion-admin-core.module.js';
import { IngestionController } from './ingestion.controller.js';

/**
 * API-side ingestion admin surface (Phase 5). Separate from IngestionModule
 * so the worker context never instantiates the controller and its auth
 * dependencies. MCP imports IngestionAdminCoreModule instead (#822).
 */
@Module({
  imports: [IngestionAdminCoreModule],
  controllers: [IngestionController],
  exports: [IngestionAdminCoreModule],
})
export class IngestionAdminModule {}
