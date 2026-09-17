import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type {
  GithubBranchesResponse,
  GithubInstallationsResponse,
  GithubReposResponse,
} from '@knowledge/contracts';
import { Access, CurrentPrincipal, Public } from '../../auth/access.decorator.js';
import type { Principal } from '../../auth/principal.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../../common/validation.js';
import type { Env } from '../../config/env.js';
import { GithubAppService } from './github-app.service.js';
import { GithubBrowseService } from './github-browse.service.js';
import { GithubOauthService } from './github-oauth.service.js';

/**
 * The repository picker's own surface (docs/features/28).
 *
 * A separate controller from `ConnectorsController` rather than more routes on
 * it, for two reasons that both matter. The first is routing: every path here
 * is a literal segment, and `ConnectorsController` already has to declare
 * literals ahead of `@Get(':id')` to stop `:id` claiming them — a second family
 * of literals on the same base path is one careless insertion away from a bug
 * Nest reports as a 404 with no explanation. The second is the ACL: these are
 * workspace-scoped reads, where the connector routes are connector-scoped.
 *
 * Browsing is `admin`, matching the rest of connector configuration: a
 * repository list is the shape of a credential's reach, and that is not an
 * ordinary viewer read.
 */
@ApiTags('connectors')
@Controller('v1/connectors/github')
export class GithubController {
  constructor(
    private readonly app: GithubAppService,
    private readonly oauth: GithubOauthService,
    private readonly browse: GithubBrowseService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Everything the picker needs to render its first frame in one call:
   * whether the feature exists at all, whether this person has connected
   * GitHub, where to send them if not, and what they can pick from if so.
   *
   * One request rather than three because all four answers change together,
   * and a picker that renders "not configured" then flickers into a list is
   * worse than one that waits.
   */
  @Get('installations')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'GitHub accounts and orgs this workspace can pick repositories from' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'returnTo', required: false })
  async installations(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Query('returnTo') returnTo?: string,
  ): Promise<GithubInstallationsResponse> {
    const empty = { installations: [], authorizeUrl: null, installUrl: null };
    if (!this.app.configured || !this.oauth.configured) {
      return { configured: false, connected: false, ...empty };
    }

    const userId = principal.userId;
    const state = this.oauth.sign(workspaceId, userId, safeReturnTo(returnTo));
    if (!state) return { configured: false, connected: false, ...empty };

    const identity = await this.oauth.identityFor(userId);
    const token = identity ? await this.oauth.tokenFor(userId) : null;

    if (!token) {
      return {
        configured: true,
        connected: false,
        authorizeUrl: this.oauth.authorizeUrl(state, this.redirectUri()),
        installUrl: null,
        installations: [],
      };
    }

    return {
      configured: true,
      connected: true,
      authorizeUrl: null,
      // Offered even when installations exist — "add another org" is the same URL.
      installUrl: this.app.installUrl(state),
      installations: await this.browse.installations(workspaceId, userId),
    };
  }

  @Get('repos')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Repositories in one installation, newest-pushed first' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'installationId', required: true })
  @ApiQuery({ name: 'q', required: false })
  async repos(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('installationId') installationId: string,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q?: string,
  ): Promise<GithubReposResponse> {
    if (!isNumericId(installationId)) return { ok: false, repositories: [], error: 'invalid installation id' };
    return this.browse.repositories(workspaceId, principal.userId, installationId, q, 50);
  }

  @Get('branches')
  @Access('admin', 'query')
  @ApiOperation({ summary: 'Branches of one repository, its default first' })
  @ApiQuery({ name: 'workspaceId', required: true })
  @ApiQuery({ name: 'installationId', required: true })
  @ApiQuery({ name: 'owner', required: true })
  @ApiQuery({ name: 'repo', required: true })
  async branches(
    @Query('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Query('installationId') installationId: string,
    @Query('owner') owner: string,
    @Query('repo') repo: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GithubBranchesResponse> {
    if (!isNumericId(installationId)) return { ok: false, branches: [], error: 'invalid installation id' };
    if (!owner || !repo) return { ok: false, branches: [], error: 'owner and repo are required' };
    return this.browse.branches(workspaceId, principal.userId, installationId, owner, repo);
  }

  /**
   * Where GitHub sends the browser back, for both legs of the flow.
   *
   * `@Public()` because the caller is a redirect from github.com carrying no
   * session cookie of ours. Its authentication is the signed `state`: without
   * that check, anyone who could reach this URL could bind an installation of
   * their choosing to a workspace of their choosing. Every path below therefore
   * verifies state *before* touching the database.
   *
   * It answers with a redirect in every case, including failure. A browser that
   * has just come back from github.com needs to land somewhere; a JSON error
   * body would strand the person on a blank page.
   */
  @Get('callback')
  @Public()
  @ApiExcludeEndpoint()
  async callback(
    @Res() res: Response,
    @Query('state') rawState?: string,
    @Query('code') code?: string,
    @Query('installation_id') installationId?: string,
  ): Promise<void> {
    const web = this.config.get('WEB_BASE_URL', { infer: true }).replace(/\/+$/, '');

    const state = rawState ? this.oauth.verify(rawState) : null;
    if (!state) {
      // Deliberately not specific: a forged or replayed state should learn
      // nothing about why it was rejected.
      res.redirect(`${web}/settings/connectors?github=error`);
      return;
    }

    // The OAuth leg, when GitHub sent a code back.
    if (code) {
      const ok = await this.oauth.completeAuthorization(code, state.userId, this.redirectUri());
      if (!ok) {
        res.redirect(`${web}${state.returnTo}?github=auth-failed`);
        return;
      }
    }

    // The install leg. Both can arrive together when someone installs and
    // authorizes in one pass, which is why this is not an `else`.
    if (installationId && isNumericId(installationId)) {
      const recorded = await this.browse.recordInstallation(state.workspaceId, installationId, state.userId);
      if (!recorded) {
        res.redirect(`${web}${state.returnTo}?github=install-failed`);
        return;
      }
    }

    res.redirect(`${web}${state.returnTo}?github=connected`);
  }

  /**
   * The OAuth redirect URI, which must match what the App registration
   * declares, byte for byte. Derived rather than configured so there is one
   * fewer env var to get wrong.
   */
  private redirectUri(): string {
    const base = this.config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/v1/connectors/github/callback`;
  }
}

/** GitHub ids are 64-bit integers; anything else is not one and must not reach BigInt(). */
function isNumericId(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{1,19}$/.test(value);
}

/**
 * The return path is echoed into a redirect, so it must be a path on our own
 * web app and nothing else. Anything absolute, protocol-relative or absent
 * collapses to the connectors screen — an open redirect here would be handed
 * out by a URL that looks like ours.
 */
function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/settings/connectors';
  return raw;
}
