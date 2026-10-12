import { Module } from '@nestjs/common';
import { PublishingCoreModule } from './publishing-core.module.js';
import { ShareLinksController } from './share-links.controller.js';

/** API-only: the management routes over PublishingCoreModule. Never import into WorkerModule. */
@Module({
  imports: [PublishingCoreModule],
  controllers: [ShareLinksController],
  exports: [PublishingCoreModule],
})
export class PublishingModule {}
