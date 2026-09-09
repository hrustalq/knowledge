import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { ExtractorFactory } from './extractor-factory.service.js';

/**
 * ExtractorFactory is the only way to get an extractor: it routes each job at
 * the workspace's `extractor` agent (docs/features/20), falling back to the
 * EXTRACTOR_* env vars it builds itself, so an install that never opens the
 * settings page is unaffected.
 *
 * There is deliberately no RELATION_EXTRACTOR provider. A single env-wired
 * instance was the pre-feature-12 shape; once the factory took over, nothing
 * injected the token, and a DI symbol nobody asks for is a claim the wiring
 * does not make.
 */
@Module({
  imports: [AgentCoreModule, AiCoreModule],
  providers: [ExtractorFactory],
  exports: [ExtractorFactory],
})
export class ExtractionModule {}
