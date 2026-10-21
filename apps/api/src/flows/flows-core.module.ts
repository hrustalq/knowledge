import { Module } from '@nestjs/common';
import { CapturesCoreModule } from '../captures/captures-core.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SearchCoreModule } from '../search/search-core.module.js';
import { VerificationCoreModule } from '../verification/verification-core.module.js';
import { FlowsService } from './flows.service.js';

/**
 * Question flows (#425), controller-free so the assistant's tools and the MCP
 * tool set share one service. API-side only: a capture opens merge requests,
 * which is CapturesCoreModule's reason for the same rule.
 */
@Module({
  imports: [PrismaModule, PermissionsCoreModule, SearchCoreModule, CapturesCoreModule, DocumentsModule, VerificationCoreModule],
  providers: [FlowsService],
  exports: [FlowsService],
})
export class FlowsCoreModule {}
