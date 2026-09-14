import { Module } from '@nestjs/common';
import { BootstrapModule } from './config/bootstrap.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { IngestionWorkerModule } from './ingestion/ingestion-worker.module.js';
import { ImportWorkerModule } from './import/import-worker.module.js';
import { WorkflowWorkerModule } from './workflows/workflow-worker.module.js';
import { ConnectorWorkerModule } from './connectors/connector-worker.module.js';
import { AgentWorkerModule } from './agents/agent-worker.module.js';

@Module({
  imports: [
    BootstrapModule,
    PrismaModule,
    IngestionWorkerModule,
    ImportWorkerModule,
    WorkflowWorkerModule,
    ConnectorWorkerModule,
    AgentWorkerModule,
  ],
})
export class WorkerModule {}
