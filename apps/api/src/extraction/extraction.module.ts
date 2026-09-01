import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { RELATION_EXTRACTOR } from './relation-extractor.provider.js';
import { NoopExtractor } from './noop.provider.js';
import { OpenAICompatibleExtractor } from './openai-compatible.provider.js';

@Module({
  providers: [
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
  exports: [RELATION_EXTRACTOR],
})
export class ExtractionModule {}
