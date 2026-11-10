import { BadRequestException, Controller, Delete, Get, HttpCode, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { oauthLandingPath, type PlaudAuthorizeResponse, type PlaudLinkResponse } from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature, Public } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { safeReturnTo } from '../common/safe-return-to.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PlaudOauthService } from './plaud-oauth.service.js';

/**
 * A person's Plaud account (#864). The sign-in is the caller's own: every
 * route acts on `principal.userId` and none takes a user id. The workspace in
 * the query is where the person is working — it decides the role and whether
 * memos are switched on there, not who owns the link.
 */
@ApiTags('memos')
@Feature('memos')
@Controller('v1/plaud')
export class PlaudController {
  constructor(
    private readonly oauth: PlaudOauthService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('link')
  @Returns('PlaudLinkResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Whether Plaud import is offered here and whether I have linked my Plaud account' })
  @ApiQuery({ name: 'workspaceId', required: true })
  status(@Query('workspaceId', ParseUUIDPipe) _workspaceId: string, @CurrentPrincipal() principal: Principal): Promise<PlaudLinkResponse> {
    return this.oauth.status(principal.userId);
  }

  /** Editor, like uploading a memo: a viewer's recording could open no merge request. */
  @Get('authorize')
  @Returns('PlaudAuthorizeResponse')
  @Access('editor', 'query')
  @ApiOperation({ summary: 'The Plaud authorization URL to link (or re-link) my account' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'returnTo', required: false })
  authorize(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Query('returnTo') returnTo?: string,
  ): PlaudAuthorizeResponse {
    const url = this.oauth.authorizeUrl(workspaceId, principal.userId, safeReturnTo(returnTo, '/memos'));
    if (!url) throw new BadRequestException(t('error.memo.plaudOff'));
    return { url };
  }

  /** Viewer: a person demoted since linking can still take their sign-in away. */
  @Delete('link')
  @HttpCode(204)
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'Unlink my Plaud account' })
  @ApiQuery({ name: 'workspaceId', required: true })
  async unlink(@Query('workspaceId', ParseUUIDPipe) _workspaceId: string, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.oauth.unlink(principal.userId);
  }

  /**
   * Where Plaud sends the browser back. `@Public()` because it is a redirect
   * from plaud.ai with no session of ours: the signed state is the whole
   * authentication, verified before anything is stored. Always a redirect, so
   * the person lands somewhere, and a rejected state learns nothing about why.
   */
  @Get('callback')
  @Public()
  @ApiExcludeEndpoint()
  async callback(@Res() res: Response, @Query('state') rawState?: string, @Query('code') code?: string): Promise<void> {
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');
    const state = rawState ? this.oauth.verify(rawState) : null;
    if (!state) {
      res.redirect(`${web}${oauthLandingPath('plaud', 'error')}`);
      return;
    }
    // No code: the person declined on Plaud's consent screen.
    const outcome = code ? await this.oauth.completeAuthorization(state, code) : 'auth-failed';
    res.redirect(`${web}${oauthLandingPath('plaud', outcome, state.returnTo)}`);
  }
}
