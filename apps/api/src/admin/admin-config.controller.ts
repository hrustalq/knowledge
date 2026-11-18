import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminConfigResponse } from '@knowledge/contracts';
import { PlatformAdmin } from '../auth/access.decorator.js';
import { Returns } from '../common/returns.decorator.js';
import { envSchema, providedEnvKeys, type Env } from '../config/env.js';
import { envReport } from '../config/env-report.js';
import { PRODUCT_VERSION } from '../config/version.js';

/**
 * The admin console's configuration view (#1237): what this API process
 * resolved, key by key. Read-only — env is owned by the deploy.
 */
@ApiTags('admin')
@PlatformAdmin()
@Controller('v1/admin')
export class AdminConfigController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get('config')
  @Returns('AdminConfigResponse')
  @ApiOperation({ summary: "This API process's resolved environment, with each key's source; secrets only as set/unset (platform admin)" })
  get(): AdminConfigResponse {
    const env = Object.fromEntries(Object.keys(envSchema.shape).map((key) => [key, this.config.get(key as keyof Env, { infer: true })]));
    return { process: 'api', version: PRODUCT_VERSION, entries: envReport(env as Env, providedEnvKeys()) };
  }
}
