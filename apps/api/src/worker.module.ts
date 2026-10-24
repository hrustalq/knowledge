import { Module } from '@nestjs/common';
import { BootstrapModule } from './config/bootstrap.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { IngestionWorkerModule } from './ingestion/ingestion-worker.module.js';
import { ImportWorkerModule } from './import/import-worker.module.js';
import { WorkflowWorkerModule } from './workflows/workflow-worker.module.js';
import { ConnectorWorkerModule } from './connectors/connector-worker.module.js';
import { AgentWorkerModule } from './agents/agent-worker.module.js';
import { MailWorkerModule } from './mail/mail-worker.module.js';
import { PublishingWorkerModule } from './publishing/publishing-worker.module.js';
import { ExportWorkerModule } from './export/export-worker.module.js';
import { EmbedsWorkerModule } from './embeds/embeds-worker.module.js';
import { AclWorkerModule } from './permissions/acl-worker.module.js';
import { AnalyticsWorkerModule } from './analytics/analytics-worker.module.js';
import { ChatWorkerModule } from './chat/chat-worker.module.js';
import { ApiTestRunWorkerModule } from './api-specs/api-test-run-worker.module.js';

@Module({
  imports: [
    BootstrapModule,
    PrismaModule,
    IngestionWorkerModule,
    ImportWorkerModule,
    WorkflowWorkerModule,
    ConnectorWorkerModule,
    AgentWorkerModule,
    MailWorkerModule,
    PublishingWorkerModule,
    ExportWorkerModule,
    EmbedsWorkerModule,
    AclWorkerModule,
    AnalyticsWorkerModule,
    ChatWorkerModule,
    ApiTestRunWorkerModule,
  ],
})
export class WorkerModule {}
