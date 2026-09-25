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
import { AiModule } from './ai/ai.module.js';
import { GlossaryModule } from './glossary/glossary.module.js';
import { ImportModule } from './import/import.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { WorkflowMaterializeModule } from './workflows/workflow-materialize.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { McpHttpModule } from './mcp/mcp-http.module.js';

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
    GlossaryModule,
    ImportModule,
    WorkflowsModule,
    // API-only: materialisation writes pages, so it runs here and not in the
    // MCP process, which imports WorkflowsModule for its read/start tools.
    WorkflowMaterializeModule,
    // MCP over Streamable HTTP at /v1/mcp (docs/features/33) — the stdio
    // server's tools, bound per request to the caller's principal.
    McpHttpModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
