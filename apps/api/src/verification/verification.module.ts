import { Module } from '@nestjs/common';
import { KnowledgeHealthController } from './knowledge-health.controller.js';
import { VerificationController } from './verification.controller.js';
import { VerificationCoreModule } from './verification-core.module.js';

/** API side: the page routes and the knowledge-health routes over VerificationCoreModule. */
@Module({
  imports: [VerificationCoreModule],
  controllers: [VerificationController, KnowledgeHealthController],
  exports: [VerificationCoreModule],
})
export class VerificationModule {}
