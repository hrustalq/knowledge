import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Post, Put, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  oauthLandingPath,
  type PlaudAuthorizeResponse,
  type PlaudImportsResponse,
  type PlaudLinkResponse,
  type PlaudSettingsResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal, Feature, Public } from '../auth/access.decorator.js';
import type { Principal } from '../auth/principal.js';
import { Returns } from '../common/returns.decorator.js';
import { safeReturnTo } from '../common/safe-return-to.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PlaudImportsService } from './plaud-imports.service.js';
import { PlaudOauthService } from './plaud-oauth.service.js';
import { PlaudImportIdsDto, PlaudImportsQueryDto, PlaudRefreshDto, PlaudTranscribeDto, SavePlaudSettingsDto } from './plaud.dto.js';

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
    private readonly imports: PlaudImportsService,
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
    // The settings and the queue are nothing without the sign-in they read through.
    await this.imports.forget(principal.userId);
  }

  @Get('settings')
  @Returns('PlaudSettingsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'My Plaud auto-import settings in this workspace: the destination project and the pick rules' })
  @ApiQuery({ name: 'workspaceId', required: true })
  settings(@Query('workspaceId', ParseUUIDPipe) workspaceId: string, @CurrentPrincipal() principal: Principal): Promise<PlaudSettingsResponse> {
    return this.imports.settings(principal.userId, workspaceId);
  }

  @Put('settings')
  @Returns('PlaudSettingsResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Save my Plaud auto-import settings; a null project switches auto-import off here' })
  saveSettings(@Body() dto: SavePlaudSettingsDto, @CurrentPrincipal() principal: Principal): Promise<PlaudSettingsResponse> {
    return this.imports.saveSettings(principal.userId, dto.workspaceId, { projectId: dto.projectId, rules: dto.rules });
  }

  @Get('imports')
  @Returns('PlaudImportsResponse')
  @Access('viewer', 'query')
  @ApiOperation({ summary: 'The Plaud recordings my rules picked, newest first' })
  async listImports(@Query() query: PlaudImportsQueryDto, @CurrentPrincipal() principal: Principal): Promise<PlaudImportsResponse> {
    return { imports: await this.imports.list(principal.userId, query.workspaceId, query.status) };
  }

  /** Editor, like the sweep it stands in for: a pass can import under `auto`. */
  @Post('imports/refresh')
  @Returns('PlaudImportsResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Look at my Plaud account now instead of waiting for the next pass; at most once in 30 seconds' })
  async refresh(@Body() dto: PlaudRefreshDto, @CurrentPrincipal() principal: Principal): Promise<PlaudImportsResponse> {
    return { imports: await this.imports.refresh(principal, dto.workspaceId) };
  }

  @Post('imports/confirm')
  @Returns('PlaudImportsResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Import these recordings: now if Plaud has transcribed them, otherwise as soon as it has' })
  async confirm(@Body() dto: PlaudImportIdsDto, @CurrentPrincipal() principal: Principal): Promise<PlaudImportsResponse> {
    return { imports: await this.imports.confirm(principal, dto.workspaceId, dto.ids) };
  }

  @Post('imports/transcribe')
  @Returns('PlaudImportsResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Transcribe one recording here instead of waiting for Plaud: spends speech-to-text, within my allowance' })
  async transcribe(@Body() dto: PlaudTranscribeDto, @CurrentPrincipal() principal: Principal): Promise<PlaudImportsResponse> {
    return { imports: [await this.imports.transcribe(principal, dto.workspaceId, dto.id)] };
  }

  @Post('imports/skip')
  @Returns('PlaudImportsResponse')
  @Access('editor', 'body')
  @ApiOperation({ summary: 'Never import these recordings; a skipped recording is not offered again' })
  async skip(@Body() dto: PlaudImportIdsDto, @CurrentPrincipal() principal: Principal): Promise<PlaudImportsResponse> {
    return { imports: await this.imports.skip(principal.userId, dto.workspaceId, dto.ids) };
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
    if (outcome === 'connected') await this.imports.ensure(state.userId, state.workspaceId);
    res.redirect(`${web}${oauthLandingPath('plaud', outcome, state.returnTo)}`);
  }
}
