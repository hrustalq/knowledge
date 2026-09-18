import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { EventsModule } from '../events/events.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ConnectorsCoreModule } from './connectors-core.module.js';
import { ConnectorWorkItemsService } from './connector-work-items.service.js';
import { GithubCoreModule } from './github/github-core.module.js';
import { GithubIssuesService } from './github/github-issues.service.js';
import { WorkItemToolsService } from './work-item-tools.service.js';

/**
 * Work items and the assistant's tools over them (docs/features/32), in a
 * controller-free module so more than one entrypoint can construct them.
 *
 * Three consumers, and they are why this is not simply part of `ConnectorsModule`:
 * that module carries controllers and therefore `AccessService` via the global
 * `AuthModule`, so nothing that imports it can load in the worker.
 *
 *   - `ConnectorsModule` — the REST surface on the connector detail page.
 *   - `AssistantModule` — the `task_*` tools in a chat turn.
 *   - `WorkflowWorkerModule` — the `task.update` step, which runs in the worker.
 *
 * That third one is the reason this is worth a module of its own rather than a
 * `*CoreModule` split later: a step kind that comments on an issue executes
 * where every other step executes, and the worker cannot reach a controller.
 *
 * `EventsModule` is the publisher-only half, which is worker-safe;
 * `ConnectorsCoreModule` supplies the connector rows and the credential
 * resolution. Nothing here can write a page.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, EventsModule, ConnectorsCoreModule, GithubCoreModule],
  providers: [GithubIssuesService, ConnectorWorkItemsService, WorkItemToolsService],
  exports: [GithubIssuesService, ConnectorWorkItemsService, WorkItemToolsService],
})
export class ConnectorWorkItemsModule {}
