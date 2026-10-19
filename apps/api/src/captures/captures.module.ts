import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { GlossaryCoreModule } from '../glossary/glossary-core.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { CapturesCoreModule } from './captures-core.module.js';
import { CaptureInboxService } from './capture-inbox.service.js';
import { CaptureSweeper } from './capture.sweeper.js';
import { AssistantCaptureController, CapturesController } from './captures.controller.js';

/**
 * Captures over REST, the inbox and the stranded-capture sweeper (issue #73,
 * phase 3). API-only: controllers and a timer. `CapturesCoreModule`, which MCP
 * loads, stays controller- and sweeper-free (`mcp-loads-no-sweeper`).
 */
@Module({
  imports: [
    PrismaModule,
    AuthCoreModule,
    PermissionsCoreModule,
    GlossaryCoreModule,
    ActivityCoreModule,
    // MergeRequestsService: bulk reject closes the merge requests a key's captures opened.
    DocumentsModule,
    CapturesCoreModule,
  ],
  controllers: [CapturesController, AssistantCaptureController],
  providers: [CaptureInboxService, CaptureSweeper],
  // The chat bots' Save (#82) is the assistant's "Save to knowledge base", from a chat.
  exports: [CaptureInboxService, CapturesCoreModule],
})
export class CapturesModule {}
