import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { AvatarsModule } from '../avatars/avatars.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublishingCoreModule } from '../publishing/publishing-core.module.js';
import { PublicRateLimiter, PublicRateLimitGuard } from './public-rate-limit.js';
import { PublicSharesController } from './public-shares.controller.js';
import { PublicSitesController } from './public-sites.controller.js';
import { PublicSitesService } from './public-sites.service.js';
import { PublicSharesService } from './public-shares.service.js';
import { PublicStore } from './public-store.js';
import { ShareUnlockService } from './share-unlock.service.js';

/**
 * Everything anonymous (docs/features/43, 44): /v1/public/*. API-only — it carries
 * a controller and imports AttachmentsModule — and never loaded by the worker
 * or the MCP process.
 */
@Module({
  imports: [PrismaModule, PublishingCoreModule, DocumentsCoreModule, AttachmentsModule, AvatarsModule],
  controllers: [PublicSharesController, PublicSitesController],
  providers: [PublicStore, PublicRateLimiter, PublicRateLimitGuard, ShareUnlockService, PublicSharesService, PublicSitesService],
})
export class PublicModule {}
