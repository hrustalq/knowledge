import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublishingCoreModule } from './publishing-core.module.js';
import { PublishingQueueModule } from './publishing-queue.module.js';
import { ShareLinksController } from './share-links.controller.js';
import { SitesController } from './sites.controller.js';
import { SitesService } from './sites.service.js';

/**
 * API-only: the management routes over PublishingCoreModule — share links
 * (docs/features/43) and published sites (docs/features/44). Never import into
 * WorkerModule; the worker's half is PublishingWorkerModule.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule, PublishingCoreModule, PublishingQueueModule],
  controllers: [ShareLinksController, SitesController],
  providers: [SitesService],
  exports: [PublishingCoreModule],
})
export class PublishingModule {}
