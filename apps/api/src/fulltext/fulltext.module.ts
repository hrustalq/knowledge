import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { FULLTEXT_PROVIDER, NoopFulltextProvider } from './fulltext.provider.js';
import { OpenSearchFulltextProvider } from './opensearch.provider.js';

/** Phase 5 BM25 layer — provider chosen by FULLTEXT_PROVIDER env (zod-validated). */
@Module({
  providers: [
    {
      provide: FULLTEXT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        config.get('FULLTEXT_PROVIDER', { infer: true }) === 'opensearch'
          ? new OpenSearchFulltextProvider(
              config.get('OPENSEARCH_URL', { infer: true }).replace(/\/$/, ''),
              config.get('OPENSEARCH_INDEX', { infer: true }),
            )
          : new NoopFulltextProvider(),
    },
  ],
  exports: [FULLTEXT_PROVIDER],
})
export class FulltextModule {}
