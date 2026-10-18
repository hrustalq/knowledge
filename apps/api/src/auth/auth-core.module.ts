import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AccessService } from './access.service.js';
import { AuditService } from './audit.service.js';
import { AuthPolicyService } from './auth-policy.service.js';

/**
 * Controller-free, guard-free half of the auth layer (docs/features/20).
 *
 * `AccessService` depends on `PrismaService` alone — it was API-only not for
 * any structural reason but because `AuthModule` also registers the two
 * APP_GUARDs and two controllers, which the worker has no business loading.
 * Splitting it lets a background agent run its tools through the *same*
 * `requireRole` check an HTTP request does, instead of a weakened copy.
 *
 * The same shape as `AiCoreModule` under `AiModule` and `EventsModule` under
 * `EventsApiModule`. `AuthModule` re-exports this so nothing that already
 * imported it has to change.
 */
@Module({
  imports: [PrismaModule],
  // AuditService rides along (Prisma only): PermissionService audits an
  // admin's bypass reads from whichever process asked (#76).
  // AuthPolicyService (#75): requireRole enforces a workspace's sign-in policy
  // in every process, so a background tool call meets the same rule.
  providers: [AccessService, AuditService, AuthPolicyService],
  exports: [AccessService, AuditService, AuthPolicyService],
})
export class AuthCoreModule {}
