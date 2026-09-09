import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { I18nModule } from 'nestjs-i18n';
import { I18nSetupModule } from './i18n/i18n-setup.module.js';
import { i18nAsyncOptions } from './i18n/i18n.config.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { IngestionWorkerModule } from './ingestion/ingestion-worker.module.js';
import { ImportWorkerModule } from './import/import-worker.module.js';
import { WorkflowWorkerModule } from './workflows/workflow-worker.module.js';

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
    PrismaModule,
    IngestionWorkerModule,
    ImportWorkerModule,
    WorkflowWorkerModule,
  ],
})
export class WorkerModule {}
