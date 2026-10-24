import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../auth/auth-core.module.js';
import { PermissionsCoreModule } from '../permissions/permissions-core.module.js';
import { ApiRunnerCoreModule } from './api-runner-core.module.js';
import { ApiSpecsCoreModule } from './api-specs-core.module.js';
import { ApiTestRunProcessor } from './api-test-run.processor.js';

/**
 * Consumer side of the QA server runner (#483, phase 5) — imported ONLY by
 * the worker entrypoint. Importing it into AppModule would make the API
 * process run suites.
 */
@Module({
  imports: [AuthCoreModule, PermissionsCoreModule, ApiSpecsCoreModule, ApiRunnerCoreModule],
  providers: [ApiTestRunProcessor],
})
export class ApiTestRunWorkerModule {}
