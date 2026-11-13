import { Module } from '@nestjs/common';
import { MemoryBanksController, MemoryProbeController } from './memory-banks.controller.js';
import { CapturesCoreModule } from '../captures/captures-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { MemoryCoreModule } from './memory-core.module.js';
import { MemoryGraphService } from './memory-graph.service.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { MemoryMcpController } from './memory-mcp.controller.js';
import { MemoryRateService } from './memory-rate.service.js';
import { MemoryOperationsSweeper } from './memory-operations.sweeper.js';
import { MemoryUnitsController } from './memory-units.controller.js';
import { MemoryWebController } from './memory-web.controller.js';
import { MemoryWebService } from './memory-web.service.js';

/**
 * Memory banks (#986): the Hindsight-shaped routes, and this platform's own
 * web routes (#994). API-only — it carries controllers, and promote reaches
 * `CaptureService`, which the worker may not.
 */
@Module({
  imports: [MemoryCoreModule, PermissionsCoreModule, CapturesCoreModule],
  controllers: [MemoryBanksController, MemoryUnitsController, MemoryMcpController, MemoryProbeController, MemoryWebController],
  // API-only: it re-enqueues, and a sweeper that also ran in the worker would do it twice.
  providers: [MemoryIntakeService, MemoryGraphService, MemoryRateService, MemoryOperationsSweeper, MemoryWebService],
  exports: [MemoryCoreModule],
})
export class MemoryModule {}
