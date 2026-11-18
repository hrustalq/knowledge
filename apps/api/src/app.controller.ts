import { Controller, Get } from '@nestjs/common';
import { CachePolicy } from './common/http-cache.js';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { Public } from './auth/access.decorator.js';
import { AppService } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Liveness for the k3s probes (#1238): the process answers HTTP. It touches
   * no store, so a down Redis or Postgres never restarts the pod, and it says
   * nothing a stranger could use; the detail is `GET /v1/admin/health`.
   */
  @Get('health')
  @Public()
  @CachePolicy('no-store')
  @ApiExcludeEndpoint()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
