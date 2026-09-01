import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AccessService } from './access.service.js';
import { AclGuard } from './acl.guard.js';
import { AuditService } from './audit.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';

/**
 * Phase 5 governance (plan.md §11). Global: AuthGuard resolves the caller on
 * every request (registration order matters — it must run before AclGuard),
 * AclGuard enforces workspace membership for routes annotated with @Access.
 * AccessService/AuditService are exported for MCP and the graph-query surface.
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuthController],
  providers: [
    AccessService,
    AuditService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AclGuard },
  ],
  exports: [AccessService, AuditService],
})
export class AuthModule {}
