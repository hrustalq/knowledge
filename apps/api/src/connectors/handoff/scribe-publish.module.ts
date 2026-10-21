import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { AuthCoreModule } from '../../auth/auth-core.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { ConnectorWorkItemsModule } from '../connector-work-items.module.js';
import { ScribePublishSweeper } from './scribe-publish.sweeper.js';

/**
 * The API half of the scribe (#433): opening a finished run's drafts as merge
 * requests and commenting the links on its ticket. Imported by `AppModule`
 * alone, the `DriftModule` precedent: `AgentFindingsService`'s module carries
 * controllers, and the comment reaches outside the workspace.
 */
@Module({
  imports: [PrismaModule, AiModule, AuthCoreModule, ConnectorWorkItemsModule],
  providers: [ScribePublishSweeper],
})
export class ScribePublishModule {}
