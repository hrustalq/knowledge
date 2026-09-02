import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AccessService } from './access.service.js';
import { AclGuard } from './acl.guard.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthFlowController } from './auth-flow.controller.js';
import { AuthFlowService } from './auth-flow.service.js';
import { AuthGuard } from './auth.guard.js';
import { SessionsService } from './sessions.service.js';

/**
 * Phase 5 governance (plan.md §11). Global: AuthGuard resolves the caller on
 * every request (registration order matters — it must run before AclGuard),
 * AclGuard enforces workspace membership for routes annotated with @Access.
 * AccessService/AuditService are exported for MCP and the graph-query surface.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuthController, AuthFlowController],
  providers: [
    AccessService,
    AuditService,
    SessionsService,
    AuthFlowService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AclGuard },
  ],
  exports: [AccessService, AuditService, SessionsService],
})
export class AuthModule {}
