import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ApiOperationsController, ApiSpecsController } from './api-specs.controller.js';
import { ApiSpecsCoreModule } from './api-specs-core.module.js';

/** The REST surface of API spec documents (#78). API-only: it carries controllers. */
@Module({
  imports: [AuthCoreModule, PermissionsCoreModule, ApiSpecsCoreModule],
  controllers: [ApiSpecsController, ApiOperationsController],
  exports: [ApiSpecsCoreModule],
})
export class ApiSpecsModule {}
