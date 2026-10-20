import { Module } from '@nestjs/common';
import { AiReadableCoreModule } from './ai-readable-core.module.js';
import { AiReadableController } from './ai-readable.controller.js';
import { LlmsTxtController } from './llms-txt.controller.js';
import { AnalyticsCoreModule } from '../analytics/analytics-core.module.js';

/**
 * API-only: carries the controllers, so it must never load in the worker.
 * AccessService / AuditService come from the global AuthModule.
 */
@Module({
  // AnalyticsCoreModule: a page read here is a view (#79).
  imports: [AiReadableCoreModule, AnalyticsCoreModule],
  controllers: [AiReadableController, LlmsTxtController],
  exports: [AiReadableCoreModule],
})
export class AiReadableModule {}
