import { Module } from '@nestjs/common';
import { MemoryBanksController, MemoryProbeController } from './memory-banks.controller.js';
import { MemoryCoreModule } from './memory-core.module.js';
import { MemoryIntakeService } from './memory-intake.service.js';
import { MemoryMcpController } from './memory-mcp.controller.js';
import { MemoryOperationsSweeper } from './memory-operations.sweeper.js';
import { MemoryUnitsController } from './memory-units.controller.js';

/** Memory banks (#986): the Hindsight-shaped routes. API-only — it carries controllers. */
@Module({
  imports: [MemoryCoreModule],
  controllers: [MemoryBanksController, MemoryUnitsController, MemoryMcpController, MemoryProbeController],
  // API-only: it re-enqueues, and a sweeper that also ran in the worker would do it twice.
  providers: [MemoryIntakeService, MemoryOperationsSweeper],
  exports: [MemoryCoreModule],
})
export class MemoryModule {}
