import { Module } from '@nestjs/common';
import { ActivityCoreModule } from '../activity/activity-core.module.js';
import { DocumentsCoreModule } from '../documents/documents-core.module.js';
import { NotificationsCoreModule } from '../notifications/notifications-core.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { KnowledgeHealthService } from './knowledge-health.service.js';
import { VerificationPolicyModule } from './verification-policy.module.js';
import { VerificationService } from './verification.service.js';

/**
 * Verification, archive and the knowledge-health reads (docs/features/39 + 40),
 * controller-free and auth-free so both processes can load it: the API for
 * the routes and `McpService` (`knowledge_flag_document`), the worker's drift
 * publisher later for "a finding flags the page". The `admin` check on bulk
 * archive lives in the controller for exactly that reason.
 *
 * `VerificationModule` (API) adds the controllers and the expiry sweeper.
 */
@Module({
  imports: [PrismaModule, ActivityCoreModule, NotificationsCoreModule, VerificationPolicyModule, DocumentsCoreModule],
  providers: [VerificationService, KnowledgeHealthService],
  exports: [VerificationService, KnowledgeHealthService, VerificationPolicyModule],
})
export class VerificationCoreModule {}
