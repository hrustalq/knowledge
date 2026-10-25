import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthSessionResponse, SsoDiscoverResponse, SsoExchangeResponse, SsoProvidersResponse } from '@knowledge/contracts';
import { Public } from '../access.decorator.js';
import { AuthRateLimit, AuthRateLimitGuard } from '../auth-rate-limit.guard.js';
import { requestMeta } from '../../common/client-ip.js';
import { t } from '../../i18n/t.js';
import { LdapLoginDto, SsoDiscoverDto, SsoExchangeDto } from './identity-providers.dto.js';
import { SsoEnabledGuard } from './sso-enabled.guard.js';
import { SsoFlowService } from './sso-flow.service.js';
import { Returns } from '../../common/returns.decorator.js';

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
  @Returns('SsoProvidersResponse')
  @ApiQuery({ name: 'workspaceId', required: false, description: "The workspace whose buttons to show (the kn_ws cookie's)" })
  @ApiOperation({ summary: 'Login buttons: enabled providers of the workspace plus every platform-wide one. 404 when SSO is off' })
  providers(@Query('workspaceId') workspaceId?: string): Promise<SsoProvidersResponse> {
    return this.sso.loginProviders(workspaceId);
  }

  @Public()
  @HttpCode(200)
  @Post('sso/discover')
  @Returns('SsoDiscoverResponse')
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit('discover')
  @ApiOperation({ summary: "Email-first sign-in: the providers that assert this address's domain (never whether an account exists)" })
  discover(@Body() dto: SsoDiscoverDto): Promise<SsoDiscoverResponse> {
    return this.sso.discover(dto.email);
  }

  @Public()
  @HttpCode(200)
  @Post('sso/exchange')
  @Returns('SsoExchangeResponse')
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

  @Public()
  @Get('saml/:providerId/start')
  @ApiExcludeEndpoint()
  async samlStart(
    @Param('providerId') providerId: string,
    @Res() res: Response,
    @Query('returnTo') returnTo?: string,
  ): Promise<void> {
    res.redirect(await this.sso.samlStart(providerId, returnTo));
  }

  /** The IdP's HTTP-POST binding. 303, so the browser follows with a GET rather than re-posting. */
  @Public()
  @Post('saml/:providerId/acs')
  @ApiExcludeEndpoint()
  async samlAcs(
    @Param('providerId') providerId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    res.redirect(303, await this.sso.samlAcs(providerId, body ?? {}, requestMeta(req)));
  }

  /**
   * OIDC Back-Channel Logout 1.0: the IdP posts `logout_token` here when a
   * session ends there. 200 when accepted, 400 `invalid_request` otherwise;
   * never cached, per §2.8. Authenticated by the token's signature alone.
   */
  @Public()
  @Post('oidc/:providerId/backchannel-logout')
  @ApiExcludeEndpoint()
  async backchannelLogout(
    @Param('providerId') providerId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const token = typeof body?.logout_token === 'string' ? body.logout_token : '';
    const ok = await this.sso.backchannelLogout(providerId, token, requestMeta(req));
    res.setHeader('Cache-Control', 'no-store');
    if (ok) res.status(200).end();
    else res.status(400).json({ error: 'invalid_request' });
  }

  @Public()
  @HttpCode(200)
  @Post('ldap/:providerId/login')
  @Returns('AuthSessionResponse')
  @UseGuards(AuthRateLimitGuard)
  @AuthRateLimit('ldap')
  @ApiOperation({
    summary: 'Sign in with a directory username and password (AUTH_LDAP_ENABLED). Wrong username and wrong password answer the same 401',
  })
  ldapLogin(@Param('providerId') providerId: string, @Body() dto: LdapLoginDto, @Req() req: Request): Promise<AuthSessionResponse> {
    return this.sso.ldapLogin(providerId, dto.username, dto.password, requestMeta(req));
  }

  /** Our SP metadata, which is also our entity ID: public by nature, it holds only our certificate. */
  @Public()
  @Get('saml/:providerId/metadata')
  @ApiExcludeEndpoint()
  async samlMetadata(@Param('providerId') providerId: string, @Res() res: Response): Promise<void> {
    const xml = await this.sso.samlMetadata(providerId);
    if (!xml) throw new NotFoundException(t('error.sso.providerNotFound'));
    res.type('application/samlmetadata+xml').send(xml);
  }
}
