import { Module } from '@nestjs/common';
import { AiReadableCoreModule } from './ai-readable-core.module.js';
import { AiReadableController } from './ai-readable.controller.js';

/** API-only: carries the controller, so it must never load in the worker. */
@Module({
  imports: [AiReadableCoreModule],
  controllers: [AiReadableController],
  exports: [AiReadableCoreModule],
})
export class AiReadableModule {}
