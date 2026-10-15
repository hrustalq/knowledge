import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
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
import { AiReadableCoreModule } from '../ai-readable/ai-readable-core.module.js';
import { FeedbackCoreModule } from '../feedback/feedback-core.module.js';
import { KnowledgeIssuesModule } from '../feedback/knowledge-issues.module.js';
import { VerificationCoreModule } from '../verification/verification-core.module.js';
import { TemplatesCoreModule } from '../templates/templates-core.module.js';
import { PublishingCoreModule } from '../publishing/publishing-core.module.js';
import { ExportCoreModule } from '../export/export-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
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
    // Page-level checks behind guard.doc/mr/project and scoped tree/graph tools (#76).
    PermissionsCoreModule,
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
    // Resource templates over the same service as the /markdown and llms.txt
    // routes (issue #68). Controller-free.
    AiReadableCoreModule,
    // Provenance on knowledge_search hits (docs/features/38). Controller-free.
    FeedbackCoreModule,
    // knowledge_report_issue (docs/features/38, phase 3). Controller-free, but
    // API-side: filing a report may open a merge request.
    KnowledgeIssuesModule,
    // knowledge_flag_document (docs/features/39). Controller-free and auth-free.
    VerificationCoreModule,
    // knowledge_list_templates / knowledge_get_template (issue #69). Controller-free.
    TemplatesCoreModule,
    // knowledge_share_page (docs/features/43). Controller-free and auth-free.
    PublishingCoreModule,
    // knowledge_export / knowledge_get_export (docs/features/45). Controller-free;
    // queues the job, which the worker builds.
    ExportCoreModule,
    // knowledge_list_agent_learnings / knowledge_propose_agent_learning (#70). Controller-free.
    AiCoreModule,
  ],
  providers: [McpService],
  exports: [McpService],
})
export class McpCoreModule {}
