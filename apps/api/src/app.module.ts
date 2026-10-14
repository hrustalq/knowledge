import { Module } from '@nestjs/common';
import { BootstrapModule } from './config/bootstrap.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { UsersModule } from './users/users.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { GraphQueryModule } from './graph/graph-query.module.js';
import { IngestionAdminModule } from './ingestion/ingestion-admin.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { AvatarsModule } from './avatars/avatars.module.js';
import { SearchModule } from './search/search.module.js';
import { EntitiesModule } from './entities/entities.module.js';
import { ActivityModule } from './activity/activity.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { EventsApiModule } from './events/events-api.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { DriftModule } from './connectors/drift/drift.module.js';
import { AiModule } from './ai/ai.module.js';
import { GlossaryModule } from './glossary/glossary.module.js';
import { ImportModule } from './import/import.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { WorkflowMaterializeModule } from './workflows/workflow-materialize.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { McpHttpModule } from './mcp/mcp-http.module.js';
import { AiReadableModule } from './ai-readable/ai-readable.module.js';
import { FeedbackModule } from './feedback/feedback.module.js';
import { VerificationModule } from './verification/verification.module.js';
import { PublishingModule } from './publishing/publishing.module.js';
import { PublicModule } from './public/public.module.js';
import { ExportModule } from './export/export.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  imports: [
    BootstrapModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    ProfilesModule,
    ProjectsModule,
    DocumentsModule,
    AttachmentsModule,
    AvatarsModule,
    SearchModule,
    EntitiesModule,
    GraphQueryModule,
    IngestionAdminModule,
    ActivityModule,
    NotificationsModule,
    EventsApiModule,
    AssistantModule,
    AiModule,
    ConnectorsModule,
    // Publishes finished drift checks (docs/features/35); API-only, sweeper.
    DriftModule,
    GlossaryModule,
    ImportModule,
    WorkflowsModule,
    // API-only: materialisation writes pages, so it runs here and not in the
    // MCP process, which imports WorkflowsModule for its read/start tools.
    WorkflowMaterializeModule,
    // Page templates (issue #69). API-only: the controller; DocumentsCoreModule
    // loads TemplatesCoreModule on its own to create a page from one.
    TemplatesModule,
    // Plain-markdown reads for agents (issue #68). API-only: carries a controller.
    AiReadableModule,
    // Votes on answers (docs/features/38, issue #67 phase 2). API-only: the
    // controller; the worker loads FeedbackCoreModule on its own.
    FeedbackModule,
    // Page verification, archive and the knowledge-health dashboard
    // (docs/features/39 + 40, issue #66). API-only: the controllers.
    VerificationModule,
    // Share links (docs/features/43, issue #77). API-only: the management
    // routes, and the anonymous /v1/public reader with its rate limiter.
    PublishingModule,
    PublicModule,
    // Exports (docs/features/45, issue #77 phase 2c). API-only: the routes and
    // the expiry sweeper; the building is ExportWorkerModule's.
    ExportModule,
    // Chat bots (issue #71). API-only: the webhook, settings, and the answer
    // turn, which runs here on a detached continuation with a reaper.
    ChatModule,
    // MCP over Streamable HTTP at /v1/mcp (docs/features/33) — the stdio
    // server's tools, bound per request to the caller's principal.
    McpHttpModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
