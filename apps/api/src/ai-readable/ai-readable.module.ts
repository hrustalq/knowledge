import { Module } from '@nestjs/common';
import { AiReadableCoreModule } from './ai-readable-core.module.js';
import { AiReadableController } from './ai-readable.controller.js';
import { LlmsTxtController } from './llms-txt.controller.js';

/**
 * API-only: carries the controllers, so it must never load in the worker.
 * AccessService / AuditService come from the global AuthModule.
 */
@Module({
  imports: [AiReadableCoreModule],
  controllers: [AiReadableController, LlmsTxtController],
  exports: [AiReadableCoreModule],
})
export class AiReadableModule {}
