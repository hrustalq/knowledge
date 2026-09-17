import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../../auth/auth-core.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConnectorAdaptersModule } from '../adapters/adapters.module.js';
import { ConnectorsCoreModule } from '../connectors-core.module.js';
import { CodeResearchService } from './code-research.service.js';
import { RepoSnapshotService } from './repo-snapshot.service.js';

/**
 * The code research tools and the repository snapshots behind them
 * (docs/features/31), in a controller-free module so both processes can
 * construct them.
 *
 * `AssistantModule` reaches them for the chat harness; `AgentWorkerModule`
 * imports the module so a background agent can read a repository — and so the
 * worker builds these services on every boot, the WebResearchModule canary:
 * the day one of them gains an API-only dependency, the worker fails loudly at
 * start rather than silently at the first tool call in a background run.
 *
 * `ConnectorsCoreModule` (not `ConnectorsModule`) for the connector rows and
 * the credential resolution, and `ConnectorAdaptersModule` for the one parser
 * instance it exports. Nothing here can write a page or a repository.
 */
@Module({
  imports: [PrismaModule, AuthCoreModule, ConnectorsCoreModule, ConnectorAdaptersModule],
  providers: [RepoSnapshotService, CodeResearchService],
  exports: [RepoSnapshotService, CodeResearchService],
})
export class CodeResearchModule {}
