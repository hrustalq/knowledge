import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublishingSettingsService } from './publishing-settings.service.js';
import { SiteAudienceStamper } from './site-audience.stamper.js';
import { ShareLinksService } from './share-links.service.js';

/**
 * Share links and the workspace's publishing switches (docs/features/43),
 * controller-free and auth-free: `McpService` creates links for
 * `knowledge_share_page`, and `PublicModule` reads the switches. Also the site
 * audience stamper, which the API (rule changes) and the worker (builds, moved
 * pages) both run.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule],
  providers: [PublishingSettingsService, ShareLinksService, SiteAudienceStamper],
  exports: [PublishingSettingsService, ShareLinksService, SiteAudienceStamper],
})
export class PublishingCoreModule {}
