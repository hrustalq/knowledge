import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { I18nModule } from 'nestjs-i18n';
import { validateEnv } from './env.js';
import { I18nSetupModule } from '../i18n/i18n-setup.module.js';
import { i18nAsyncOptions } from '../i18n/i18n.config.js';

/**
 * The prelude every entrypoint needs: validated env + i18n.
 *
 * It was copy-pasted verbatim into `AppModule`, `WorkerModule` and `McpModule`,
 * which is how the drift this file exists to stop actually happened — a
 * docstring in one of the three described a rule the other two had stopped
 * following, and nothing pointed the reader at a single truth.
 *
 * Safe to nest one level down: `ConfigModule.forRoot({ isGlobal: true })`
 * registers globally wherever it is imported, and `I18nModule` is `@Global()`.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // cwd-first, repo root as fallback: `make dev` (turbo) runs with
      // cwd=apps/api, so apps/api/.env wins for keys it defines and the root
      // .env fills everything else (assistant/extractor/auth/... sections).
      // When run from the repo root (dist scripts, MCP), only ['.env'] hits.
      envFilePath: ['.env', '../../.env'],
    }),
    I18nModule.forRootAsync(i18nAsyncOptions),
    I18nSetupModule,
  ],
})
export class BootstrapModule {}
