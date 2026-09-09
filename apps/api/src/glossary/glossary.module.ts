import { Module } from '@nestjs/common';
import { GlossaryCoreModule } from './glossary-core.module.js';
import { GlossaryController } from './glossary.controller.js';

/**
 * Glossary (docs/features/14). API-only — the controller depends on the global
 * auth guards, so this stays out of WorkerModule and McpModule (same rationale
 * as GraphQueryModule).
 *
 * GlossaryService itself lives in GlossaryCoreModule, which the worker loads
 * for the background glossarist (docs/features/20). Re-exported here so every
 * existing `imports: [GlossaryModule]` keeps resolving the service.
 */
@Module({
  imports: [GlossaryCoreModule],
  controllers: [GlossaryController],
  exports: [GlossaryCoreModule],
})
export class GlossaryModule {}
