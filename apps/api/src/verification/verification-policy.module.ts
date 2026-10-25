import { Module } from '@nestjs/common';
import { ReadCacheCoreModule } from '../cache/read-cache.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { VerificationPolicyService } from './verification-policy.service.js';

/**
 * Leaf: the effective freshness settings of a workspace (docs/features/40).
 * Imported by DocumentsCoreModule, SearchCoreModule and VerificationCoreModule
 * alike, which is why it carries nothing but Prisma, the env and the read cache.
 */
@Module({
  imports: [PrismaModule, ReadCacheCoreModule],
  providers: [VerificationPolicyService],
  exports: [VerificationPolicyService],
})
export class VerificationPolicyModule {}
