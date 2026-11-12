import { Module } from '@nestjs/common';
import { MemoryBanksController, MemoryProbeController } from './memory-banks.controller.js';
import { MemoryCoreModule } from './memory-core.module.js';
import { MemoryUnitsController } from './memory-units.controller.js';

/** Memory banks (#986): the Hindsight-shaped routes. API-only — it carries controllers. */
@Module({
  imports: [MemoryCoreModule],
  controllers: [MemoryBanksController, MemoryUnitsController, MemoryProbeController],
  exports: [MemoryCoreModule],
})
export class MemoryModule {}
