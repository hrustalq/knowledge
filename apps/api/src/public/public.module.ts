import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { AssistantClientModule } from '../assistant/assistant-client.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { AvatarsModule } from '../avatars/avatars.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PublishingCoreModule } from '../publishing/publishing-core.module.js';
import { PublicAskService } from './public-ask.service.js';
import { PublicRateLimiter, PublicRateLimitGuard } from './public-rate-limit.js';
import { PublicSharesController } from './public-shares.controller.js';
import { PublicDomainsController, PublicSiteFilesController } from './public-site-files.controller.js';
import { PublicSiteFilesService } from './public-site-files.service.js';
import { PublicSiteSearchService } from './public-site-search.service.js';
import { PublicSitesController } from './public-sites.controller.js';
import { PublicSitesService } from './public-sites.service.js';
import { PublicSharesService } from './public-shares.service.js';
import { PublicStore } from './public-store.js';
import { ShareUnlockService } from './share-unlock.service.js';
import { SiteSessionService } from './site-session.service.js';
import { SiteSignInController } from './site-sign-in.controller.js';

/**
 * Everything anonymous (docs/features/43, 44): /v1/public/*. API-only — it carries
 * a controller and imports AttachmentsModule — and never loaded by the worker
 * or the MCP process. Also the one authenticated route of site sign-in
 * (`SiteSignInController`, issue #77 phase 3), which issues the codes the
 * public session route spends: both halves share `SiteSessionService`.
 */
@Module({
  imports: [
    PrismaModule,
    PublishingCoreModule,
    DocumentsCoreModule,
    AttachmentsModule,
    AvatarsModule,
    // A site's Ask (issue #77 phase 3): provider resolution, the client, retrieval.
    AiCoreModule,
    AssistantClientModule,
    GraphModule,
    EmbeddingModule,
  ],
  controllers: [PublicSharesController, PublicSitesController, PublicSiteFilesController, PublicDomainsController, SiteSignInController],
  providers: [
    PublicStore,
    PublicRateLimiter,
    PublicRateLimitGuard,
    ShareUnlockService,
    PublicSharesService,
    PublicSitesService,
    PublicSiteFilesService,
    PublicSiteSearchService,
    PublicAskService,
    SiteSessionService,
  ],
})
export class PublicModule {}
