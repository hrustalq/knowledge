import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from './auth-core.module.js';
import { MailQueueModule } from '../mail/mail-queue.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { AclGuard } from './acl.guard.js';
import { ApiKeysService } from './api-keys.service.js';
import { AuthController } from './auth.controller.js';
import { AuthFlowController } from './auth-flow.controller.js';
import { AuthFlowService } from './auth-flow.service.js';
import { AuthGuard } from './auth.guard.js';
import { AuthRateLimitGuard } from './auth-rate-limit.guard.js';
import { MeController } from './me.controller.js';
import { AuthTokensModule } from './auth-tokens.module.js';
import { PublicRateLimiter } from '../public/public-rate-limit.js';
import { PublicStore } from '../public/public-store.js';

/**
 * Phase 5 governance (plan.md §11). Global: AuthGuard resolves the caller on
 * every request (registration order matters — it must run before AclGuard),
 * AclGuard enforces workspace membership for routes annotated with @Access.
 * AccessService/AuditService are exported for MCP and the graph-query surface.
 */
@Global()
@Module({
  // PermissionsCoreModule: AclGuard asks it about the page behind a `:id` (#76).
  imports: [PrismaModule, AuthCoreModule, AuthTokensModule, PermissionsCoreModule, MailQueueModule],
  controllers: [AuthController, AuthFlowController, MeController],
  providers: [
    ApiKeysService,
    AuthFlowService,
    // The anonymous auth routes' budgets (#75): the same Redis fixed window the
    // public routes count with, registered here as api-specs registers it.
    PublicStore,
    PublicRateLimiter,
    AuthRateLimitGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AclGuard },
  ],
  // AuthCoreModule is re-exported so existing importers keep getting AccessService,
  // and AuthTokensModule so they keep getting SessionsService and TokenAuthService.
  // AuthFlowService + the limiter: SSO sign-in (#75) opens its sessions and
  // counts its routes the way a password login does.
  exports: [AuthCoreModule, AuthTokensModule, AuthFlowService, PublicRateLimiter, AuthRateLimitGuard],
})
export class AuthModule {}
