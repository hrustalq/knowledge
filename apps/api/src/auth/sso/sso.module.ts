import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { IdentityProvidersController } from './identity-providers.controller.js';
import { IdentityProvidersService } from './identity-providers.service.js';
import { OidcService } from './oidc.service.js';
import { SsoController } from './sso.controller.js';
import { SsoEnabledGuard } from './sso-enabled.guard.js';
import { SsoFlowService } from './sso-flow.service.js';
import { SsoLoginService } from './sso-login.service.js';

/**
 * Enterprise SSO (#75). API-only — it carries controllers, and the API
 * authenticates while the worker never does — so `AppModule` alone imports
 * it. Sessions, the audit trail, the shared session response and the rate
 * limiter come from the global `AuthModule`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [SsoController, IdentityProvidersController],
  providers: [OidcService, SsoLoginService, SsoFlowService, IdentityProvidersService, SsoEnabledGuard],
})
export class SsoModule {}
