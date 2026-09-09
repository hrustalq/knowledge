import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthCoreModule } from './auth-core.module.js';
import { AclGuard } from './acl.guard.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthFlowController } from './auth-flow.controller.js';
import { AuthFlowService } from './auth-flow.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionsService } from './sessions.service.js';
import { TokenAuthService } from './token-auth.service.js';

/**
 * Phase 5 governance (plan.md §11). Global: AuthGuard resolves the caller on
 * every request (registration order matters — it must run before AclGuard),
 * AclGuard enforces workspace membership for routes annotated with @Access.
 * AccessService/AuditService are exported for MCP and the graph-query surface.
 */
@Global()
@Module({
  imports: [PrismaModule, AuthCoreModule],
  controllers: [AuthController, AuthFlowController],
  providers: [
    AuditService,
    SessionsService,
    TokenAuthService,
    AuthFlowService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AclGuard },
  ],
  // AuthCoreModule is re-exported so existing importers keep getting AccessService.
  exports: [AuthCoreModule, AuditService, SessionsService, TokenAuthService],
})
export class AuthModule {}
