import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { RELATION_EXTRACTOR } from './relation-extractor.provider.js';
import { NoopExtractor } from './noop.provider.js';
import { OpenAICompatibleExtractor } from './openai-compatible.provider.js';
import { ExtractorFactory } from './extractor-factory.service.js';

/**
 * RELATION_EXTRACTOR is the env-configured extractor and remains the fallback.
 * ExtractorFactory is what the processor actually asks: it routes each job at
 * the workspace's 'extraction' provider profile when one is set, and returns
 * this same instance when none is (docs/features/12).
 */
@Module({
  imports: [AiCoreModule],
  providers: [
    ExtractorFactory,
    {
      provide: RELATION_EXTRACTOR,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        if (config.get('EXTRACTOR_PROVIDER', { infer: true }) === 'openai-compatible') {
          return new OpenAICompatibleExtractor(
            config.get('EXTRACTOR_BASE_URL', { infer: true }),
            config.get('EXTRACTOR_MODEL', { infer: true }),
            config.get('EXTRACTOR_API_KEY', { infer: true }),
            config.get('EXTRACTOR_MIN_CONFIDENCE', { infer: true }),
            config.get('EXTRACTOR_MAX_CHUNKS', { infer: true }),
          );
        }
        return new NoopExtractor();
      },
    },
  ],
  exports: [RELATION_EXTRACTOR, ExtractorFactory],
})
export class ExtractionModule {}
