import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { GraphModule } from '../graph/graph.module.js';
import { EmbeddingModule } from '../embedding/embedding.module.js';
import { AiCoreModule } from '../ai/ai-core.module.js';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { CaptureService } from './capture.service.js';

/**
 * Agent-session captures (issue #73), controller-free so the MCP tool set can
 * inject `CaptureService` on both transports. API-side all the same: a capture
 * opens merge requests, so it needs DocumentsModule (MergeRequestsService) and
 * never loads in the worker — dependency-cruiser holds both lines.
 */
@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthCoreModule,
    PermissionsCoreModule,
    DocumentsModule,
    GraphModule,
    EmbeddingModule,
    AiCoreModule,
    ActivityCoreModule,
  ],
  providers: [CaptureService],
  exports: [CaptureService],
})
export class CapturesCoreModule {}
