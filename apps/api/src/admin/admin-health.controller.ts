import { Controller, Get } from '@nestjs/common';
import { CachePolicy } from '../common/http-cache.js';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AdminHealthResponse } from '@knowledge/contracts';
import { PlatformAdmin } from '../auth/access.decorator.js';
import { Returns } from '../common/returns.decorator.js';
import { AdminHealthService } from './admin-health.service.js';

/** The admin console's monitoring view (#1238). `GET /health` is the public, detail-free liveness twin. */
@ApiTags('admin')
@PlatformAdmin()
@Controller('v1/admin')
export class AdminHealthController {
  constructor(private readonly health: AdminHealthService) {}

  @Get('health')
  @CachePolicy('no-store')
  @Returns('AdminHealthResponse')
  @ApiOperation({
    summary:
      'Every store probed (status, latency), BullMQ counts per queue, process heartbeats and each sweeper\'s last tick (platform admin)',
  })
  get(): Promise<AdminHealthResponse> {
    return this.health.read();
  }
}
