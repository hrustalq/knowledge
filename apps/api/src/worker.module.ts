import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
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
    PrismaModule,
    IngestionWorkerModule,
    ImportWorkerModule,
    WorkflowWorkerModule,
  ],
})
export class WorkerModule {}
