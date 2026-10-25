import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReadCacheCoreModule } from '../cache/read-cache.module.js';
import { ReadCache, READ_CACHE_FAMILIES } from '../cache/read-cache.service.js';
import type { Env } from '../config/env.js';
import { EMBEDDING_PROVIDER, embeddingSignature, type EmbeddingProvider } from './embedding.provider.js';
import { DeterministicStubProvider } from './stub.provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';

/**
 * A query embedded once is embedded for good in that space (#472): `embed` —
 * the single-text call a search, an ask or a capture dedupe makes — reads
 * through the read cache. `embedBatch` is indexing, whose texts never repeat.
 */
function cachedEmbed(provider: EmbeddingProvider, cache: ReadCache, signature: string): EmbeddingProvider {
  const family = READ_CACHE_FAMILIES.embedding;
  return {
    dimension: provider.dimension,
    embed: (text) => cache.wrap('global', family.key(signature, text), () => provider.embed(text), family.ttlMs),
    embedBatch: (texts) => provider.embedBatch(texts),
  };
}

@Module({
  imports: [ReadCacheCoreModule],
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService, ReadCache],
      useFactory: (config: ConfigService<Env, true>, cache: ReadCache) => {
        const dim = config.get('EMBEDDINGS_DIM', { infer: true });
        const provider =
          config.get('EMBEDDINGS_PROVIDER', { infer: true }) === 'openai-compatible'
            ? new OpenAICompatibleProvider(
                config.get('EMBEDDINGS_BASE_URL', { infer: true }),
                config.get('EMBEDDINGS_MODEL', { infer: true }),
                config.get('EMBEDDINGS_API_KEY', { infer: true }),
                dim,
              )
            : new DeterministicStubProvider(dim);
        return cachedEmbed(provider, cache, embeddingSignature(config));
      },
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
