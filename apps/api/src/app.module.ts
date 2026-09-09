import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.js';
import { I18nModule } from 'nestjs-i18n';
import { I18nSetupModule } from './i18n/i18n-setup.module.js';
import { i18nAsyncOptions } from './i18n/i18n.config.js';
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
import { SearchModule } from './search/search.module.js';
import { EntitiesModule } from './entities/entities.module.js';
import { ActivityModule } from './activity/activity.module.js';
import { EventsApiModule } from './events/events-api.module.js';
import { AssistantModule } from './assistant/assistant.module.js';
import { ConnectorsModule } from './connectors/connectors.module.js';
import { AiModule } from './ai/ai.module.js';
import { GlossaryModule } from './glossary/glossary.module.js';
import { ImportModule } from './import/import.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

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
    AuthModule,
    UsersModule,
    WorkspacesModule,
    ProfilesModule,
    ProjectsModule,
    DocumentsModule,
    AttachmentsModule,
    SearchModule,
    EntitiesModule,
    GraphQueryModule,
    IngestionAdminModule,
    ActivityModule,
    EventsApiModule,
    AssistantModule,
    AiModule,
    ConnectorsModule,
    GlossaryModule,
    ImportModule,
    WorkflowsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
