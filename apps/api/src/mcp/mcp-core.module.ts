import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { IngestionAdminModule } from '../ingestion/ingestion-admin.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { SearchModule } from '../search/search.module.js';
import { EntitiesModule } from '../entities/entities.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { ConnectorsCoreModule } from '../connectors/connectors-core.module.js';
import { ConnectorQueueModule } from '../connectors/connector-queue.module.js';
import { ConnectorWorkItemsModule } from '../connectors/connector-work-items.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { AgentCoreModule } from '../agents/agent-core.module.js';
import { McpService } from './mcp.service.js';

/**
 * The tool set, controller-free (docs/features/33), shared by both transports:
 * `McpModule` serves it on stdio, `McpHttpModule` at POST /v1/mcp inside the
 * API. Task-level tools over the same services the REST API uses — never raw
 * SQL/Cypher access (plan.md §9).
 */
@Module({
  imports: [
    PrismaModule,
    AuthCoreModule,
    GraphModule,
    IngestionAdminModule,
    StorageModule,
    DocumentsModule,
    SearchModule,
    EntitiesModule,
    ProjectsModule,
    ConnectorsCoreModule,
    ConnectorQueueModule,
    // Work items (docs/features/32), read-only over this surface: opening an
    // issue is attributed to a person, which is the same reason workflow
    // approval is not exposed here either.
    ConnectorWorkItemsModule,
    // Read/start tools only. WorkflowMaterializeModule is deliberately absent —
    // materialisation writes pages and belongs to the API process.
    WorkflowsModule,
    // The registry only — AiAgentsService is API-only (it validates tool lists
    // against the plugin roster) and the agent tools here are read-only anyway.
    AgentCoreModule,
  ],
  providers: [McpService],
  exports: [McpService],
})
export class McpCoreModule {}
