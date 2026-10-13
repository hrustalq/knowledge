import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublishingCoreModule } from './publishing-core.module.js';
import { PublishingQueueModule } from './publishing-queue.module.js';
import { PublishingSweeper } from './publishing.sweeper.js';
import { ShareLinksController } from './share-links.controller.js';
import { SiteAudiencesService } from './site-audiences.service.js';
import { SiteDomainsService } from './site-domains.service.js';
import { SitesController } from './sites.controller.js';
import { SitesService } from './sites.service.js';

/**
 * API-only: the management routes over PublishingCoreModule — share links
 * (docs/features/43) and published sites (docs/features/44), with their
 * custom domains and PublishingSweeper. Never import into WorkerModule; the
 * worker's half is PublishingWorkerModule.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule, AiCoreModule, PublishingCoreModule, PublishingQueueModule],
  controllers: [ShareLinksController, SitesController],
  providers: [SitesService, SiteDomainsService, SiteAudiencesService, PublishingSweeper],
  exports: [PublishingCoreModule],
})
export class PublishingModule {}
