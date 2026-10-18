import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { IdentityProvidersController } from './identity-providers.controller.js';
import { IdentityProvidersService } from './identity-providers.service.js';
import { OidcService } from './oidc.service.js';
import { SamlService } from './saml.service.js';
import { SsoController } from './sso.controller.js';
import { SsoEnabledGuard, SsoOrScimEnabledGuard } from './sso-enabled.guard.js';
import { SsoFlowService } from './sso-flow.service.js';
import { SsoLoginService } from './sso-login.service.js';
import { GroupMappingsController } from './group-mappings.controller.js';
import { GroupMappingsService } from './group-mappings.service.js';
import { RoleSyncService } from './role-sync.service.js';
import { AuthPolicyController, SsoDomainsController } from './enforcement.controller.js';
import { SsoDomainsService } from './sso-domains.service.js';
import { DNS_TXT_LOOKUP, systemTxtLookup } from './sso-dns.js';
import { SsoMaintenanceSweeper } from './sso-maintenance.sweeper.js';

/**
 * Enterprise SSO (#75). API-only — it carries controllers, and the API
 * authenticates while the worker never does — so `AppModule` alone imports
 * it. The policy itself (`AuthPolicyService`) is in `AuthCoreModule`, because
 * `requireRole` reads it in every process; its routes and the domains are
 * here. Sessions, the audit trail, the shared session response and the rate
 * limiter come from the global `AuthModule`.
 */
@Module({
  imports: [PrismaModule],
  controllers: [SsoController, IdentityProvidersController, GroupMappingsController, AuthPolicyController, SsoDomainsController],
  providers: [
    OidcService,
    SamlService,
    SsoLoginService,
    SsoFlowService,
    IdentityProvidersService,
    RoleSyncService,
    GroupMappingsService,
    SsoDomainsService,
    SsoMaintenanceSweeper,
    { provide: DNS_TXT_LOOKUP, useFactory: systemTxtLookup },
    SsoEnabledGuard,
    SsoOrScimEnabledGuard,
  ],
  // ScimModule re-syncs roles on provisioning changes through the same service.
  exports: [RoleSyncService],
})
export class SsoModule {}
