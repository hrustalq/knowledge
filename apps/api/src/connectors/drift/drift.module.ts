import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConnectorsCoreModule } from '../connectors-core.module.js';
import { DriftPublishSweeper } from './drift-publish.sweeper.js';

/**
 * The API half of the drift check (docs/features/35) — publishing a finished
 * run. Imported by `AppModule` alone: the sweeper opens merge requests through
 * `AgentFindingsService`, whose module carries controllers, and writes to a
 * pull request, which no unattended process may do.
 *
 * The trigger half is not here: `DriftTriggerService` is provided by
 * `ConnectorsModule`, beside the two webhook controllers that call it.
 */
@Module({
  imports: [PrismaModule, AiModule, ConnectorsCoreModule],
  providers: [DriftPublishSweeper],
})
export class DriftModule {}
