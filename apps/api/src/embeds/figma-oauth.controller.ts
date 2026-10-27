import { BadRequestException, Controller, Delete, Get, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { FigmaAuthorizeResponse, FigmaOauthStatusResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Public } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { safeReturnTo } from '../common/safe-return-to.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { ConnectorsService } from '../connectors/connectors.service.js';
import { t } from '../i18n/t.js';
import { FigmaOauthService } from './figma-oauth.service.js';

/**
 * Connect with Figma (#557, docs/features/64). Admin, like the rest of
 * connector configuration. Every path is two segments under `v1/connectors`,
 * so `ConnectorsController`'s `@Get(':id')` cannot claim one.
 */
@ApiTags('connectors')
@Controller('v1/connectors')
export class FigmaOauthController {
  constructor(
    private readonly oauth: FigmaOauthService,
    private readonly connectors: ConnectorsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('figma/oauth')
  @Returns('FigmaOauthStatusResponse')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Whether Connect with Figma is offered on this deployment' })
  @ApiQuery({ name: 'workspaceId', required: true })
  status(@Query('workspaceId', ParseUUIDPipe) _workspaceId: string): FigmaOauthStatusResponse {
    return { configured: this.oauth.configured };
  }

  /** Where to send the browser to connect (or reconnect) this connector. */
  @Get(':id/figma/authorize')
  @Returns('FigmaAuthorizeResponse')
  @Access('admin', 'connector')
  @ApiOperation({ summary: 'The Figma authorization URL for a Figma connector' })
  @ApiQuery({ name: 'returnTo', required: false })
  async authorize(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('returnTo') returnTo?: string,
  ): Promise<FigmaAuthorizeResponse> {
    const row = await this.connectors.require(id);
    const url =
      row.kind === 'figma'
        ? this.oauth.authorizeUrl(row.workspaceId, principal.userId, row.id, safeReturnTo(returnTo, `/settings/connectors/${row.id}`))
        : null;
    if (!url) throw new BadRequestException(t('error.connector.figmaOauthOff'));
    return { url };
  }

  @Delete(':id/figma/grant')
  @Access('admin', 'connector')
  @ApiOperation({ summary: 'Disconnect a Figma connector from its OAuth grant' })
  async disconnect(@Param('id', ParseUUIDPipe) id: string): Promise<{ disconnected: boolean }> {
    await this.oauth.disconnect(id);
    return { disconnected: true };
  }

  /**
   * Where Figma sends the browser back. `@Public()` because it is a redirect
   * from figma.com with no session of ours: the signed state is the whole
   * authentication, verified before anything is stored. Always a redirect, so
   * the person lands somewhere, and a rejected state learns nothing about why.
   */
  @Get('figma/callback')
  @Public()
  @ApiExcludeEndpoint()
  async callback(@Res() res: Response, @Query('state') rawState?: string, @Query('code') code?: string): Promise<void> {
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const state = rawState ? this.oauth.verify(rawState) : null;
    if (!state) {
      res.redirect(`${web}/settings/connectors?figma=error`);
      return;
    }
    // No code: the person pressed Cancel on figma.com.
    const ok = code ? await this.oauth.completeAuthorization(state, code) : false;
    const sep = state.returnTo.includes('?') ? '&' : '?';
    res.redirect(`${web}${state.returnTo}${sep}figma=${ok ? 'connected' : 'auth-failed'}`);
  }
}
