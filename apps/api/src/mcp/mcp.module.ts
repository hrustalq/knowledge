import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '../config/env.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { SearchModule } from '../search/search.module.js';
import { EntitiesModule } from '../entities/entities.module.js';
import { McpService } from './mcp.service.js';

/**
 * MCP entrypoint module (plan.md §9): task-level tools over the same services
 * the REST API uses — never raw SQL/Cypher access. Started via mcp.main.ts,
 * no HTTP listener, stdio transport.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    StorageModule,
    DocumentsModule,
    SearchModule,
    EntitiesModule,
  ],
  providers: [McpService],
})
export class McpModule {}
