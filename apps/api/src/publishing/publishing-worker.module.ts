import { Module } from '@nestjs/common';
import { EventsSubscriberModule } from '../events/events-subscriber.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublishingQueueModule } from './publishing-queue.module.js';
import { SiteBuildProcessor } from './site-build.processor.js';
import { SiteBuildService } from './site-build.service.js';
import { SiteRebuildTrigger } from './site-rebuild.trigger.js';

/**
 * Consumer side of site builds (docs/features/44) — imported ONLY by the
 * worker entrypoint (worker.module.ts). The trigger lives here too: it reads
 * the event bus and enqueues, and the builds it starts run in this process.
 */
@Module({
  imports: [PrismaModule, PublishingQueueModule, EventsSubscriberModule],
  providers: [SiteBuildService, SiteBuildProcessor, SiteRebuildTrigger],
})
export class PublishingWorkerModule {}
