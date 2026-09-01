import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { EMBEDDING_PROVIDER } from './embedding.provider.js';
import { DeterministicStubProvider } from './stub.provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';

@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const dim = config.get('EMBEDDINGS_DIM', { infer: true });
        if (config.get('EMBEDDINGS_PROVIDER', { infer: true }) === 'openai-compatible') {
          return new OpenAICompatibleProvider(
            config.get('EMBEDDINGS_BASE_URL', { infer: true }),
            config.get('EMBEDDINGS_MODEL', { infer: true }),
            config.get('EMBEDDINGS_API_KEY', { infer: true }),
            dim,
          );
        }
        return new DeterministicStubProvider(dim);
      },
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingModule {}
