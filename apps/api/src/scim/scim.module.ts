import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { SsoModule } from '../auth/sso/sso.module.js';
import { ScimController } from './scim.controller.js';
import { ScimTokenGuard } from './scim-token.guard.js';
import { ScimEnabledGuard, ScimTokensController } from './scim-tokens.controller.js';
import { ScimTokensService } from './scim-tokens.service.js';
import { ScimService } from './scim.service.js';

/**
 * SCIM 2.0 provisioning (#75 phase 5). API-only — it carries controllers, and
 * the API authenticates while the worker never does — so `AppModule` alone
 * imports it. Role sync comes from `SsoModule`, which owns the mappings;
 * sessions and the audit trail from the global `AuthModule`.
 */
@Module({
  imports: [PrismaModule, SsoModule],
  controllers: [ScimController, ScimTokensController],
  providers: [ScimService, ScimTokensService, ScimTokenGuard, ScimEnabledGuard],
})
export class ScimModule {}
