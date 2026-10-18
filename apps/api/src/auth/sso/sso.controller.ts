import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { SsoDiscoverResponse, SsoExchangeResponse, SsoProvidersResponse } from '@knowledge/contracts';
import { Public } from '../access.decorator.js';
import { AuthRateLimit, AuthRateLimitGuard } from '../auth-rate-limit.guard.js';
import { requestMeta } from '../../common/client-ip.js';
import { SsoDiscoverDto, SsoExchangeDto } from './identity-providers.dto.js';
import { SsoEnabledGuard } from './sso-enabled.guard.js';
import { SsoFlowService } from './sso-flow.service.js';

/**
 * Anonymous SSO sign-in routes (#75). `@Public()` because the caller has no
 * session yet; what authenticates the callback is the server-side login
 * transaction its `state` names. The redirect legs always answer a redirect —
 * a browser that has just come back from an IdP needs to land somewhere, and
 * a JSON error would strand it on a blank page.
 */
@ApiTags('auth')
@Controller('v1/auth')
@UseGuards(SsoEnabledGuard)
export class SsoController {
  constructor(private readonly sso: SsoFlowService) {}

  @Public()
  @Get('sso/providers')
  @ApiQuery({ name: 'workspaceId', required: false, description: "The workspace whose buttons to show (the kn_ws cookie's)" })
  @ApiOperation({ summary: 'Login buttons: enabled providers of the workspace plus every platform-wide one. 404 when SSO is off' })
  providers(@Query('workspaceId') workspaceId?: string): Promise<SsoProvidersResponse> {
    return this.sso.loginProviders(workspaceId);
  }

  @Public()
  @HttpCode(200)
  @Post('sso/discover')
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit('discover')
  @ApiOperation({ summary: "Email-first sign-in: the providers that assert this address's domain (never whether an account exists)" })
  discover(@Body() dto: SsoDiscoverDto): Promise<SsoDiscoverResponse> {
    return this.sso.discover(dto.email);
  }

  @Public()
  @HttpCode(200)
  @Post('sso/exchange')
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit('exchange')
  @ApiOperation({ summary: 'Trade the single-use code from /auth/sso/complete for a ks_ session token' })
  exchange(@Body() dto: SsoExchangeDto, @Req() req: Request): Promise<SsoExchangeResponse> {
    return this.sso.exchange(dto.code, requestMeta(req));
  }

  @Public()
  @Get('oidc/:providerId/start')
  @ApiExcludeEndpoint()
  async start(
    @Param('providerId') providerId: string,
    @Res() res: Response,
    @Query('returnTo') returnTo?: string,
  ): Promise<void> {
    res.redirect(await this.sso.start(providerId, returnTo));
  }

  @Public()
  @Get('oidc/:providerId/callback')
  @ApiExcludeEndpoint()
  async callback(@Param('providerId') providerId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const query = new URL(req.originalUrl, 'http://callback.invalid').searchParams;
    res.redirect(await this.sso.callback(providerId, query, requestMeta(req)));
  }
}
