import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConnectorsCoreModule } from '../connectors-core.module.js';
import { VerificationCoreModule } from '../../verification/verification-core.module.js';
import { DriftPublishSweeper } from './drift-publish.sweeper.js';
import { SourceChangePublishSweeper } from './source-change-publish.sweeper.js';

/**
 * The API half of the drift check (docs/features/35) — publishing a finished
 * run. Imported by `AppModule` alone: the sweeper opens merge requests through
 * `AgentFindingsService`, whose module carries controllers, and writes to a
 * pull request, which no unattended process may do.
 *
 * The trigger half is not here: `DriftTriggerService` is provided by
 * `ConnectorsModule`, beside the two webhook controllers that call it.
 *
 * `VerificationCoreModule` for the page flags (docs/features/39): a finding
 * asks for a check, a merged pull request declares the page outdated.
 */
@Module({
  imports: [PrismaModule, AiModule, ConnectorsCoreModule, VerificationCoreModule],
  // The source-change publisher (#674, phase 5b) shares the sentinel and the
  // same two needs: a principal for proposals, and the page flags.
  providers: [DriftPublishSweeper, SourceChangePublishSweeper],
})
export class DriftModule {}
