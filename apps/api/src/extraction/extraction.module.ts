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
/*
 * AiCoreModule also supplies AiUsageService: extraction is billed like every
 * other upstream call (docs/features/12). It records directly rather than going
 * through AssistantClient, for the same reason the OCR parser does — that
 * client appends the locale directive to every prompt, and this one must stay
 * unlocalized so its graph keys (`service:identity`) are identical whatever
 * language the page is written in. It also pins temperature 0, which the
 * shared client cannot express.
 */
@Module({
  imports: [AgentCoreModule, AiCoreModule],
  providers: [ExtractorFactory],
  exports: [ExtractorFactory],
})
export class ExtractionModule {}
