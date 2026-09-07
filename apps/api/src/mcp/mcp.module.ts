import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionAdminModule } from '../ingestion/ingestion-admin.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { SearchModule } from '../search/search.module.js';
import { EntitiesModule } from '../entities/entities.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { McpService } from './mcp.service.js';

/**
 * MCP entrypoint module (plan.md §9): task-level tools over the same services
 * the REST API uses — never raw SQL/Cypher access. Started via mcp.main.ts,
 * no HTTP listener, stdio transport.
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
    PrismaModule,
    AuthModule,
    GraphModule,
    IngestionAdminModule,
    StorageModule,
    DocumentsModule,
    SearchModule,
    EntitiesModule,
    ProjectsModule,
  ],
  providers: [McpService],
})
export class McpModule {}
