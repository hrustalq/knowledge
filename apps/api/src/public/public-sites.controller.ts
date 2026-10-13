import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import {
  SITE_SEARCH_MAX_CHARS,
  siteSessionCookieName,
  type PublicSiteResolveResponse,
  type PublicSiteSearchResponse,
} from '@knowledge/contracts';
import { Public } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PublicRateLimitGuard } from './public-rate-limit.js';
import { PublicSiteSearchService } from './public-site-search.service.js';
import { PublicSitesService } from './public-sites.service.js';
import { SiteSessionService } from './site-session.service.js';

export class ResolveSiteQueryDto {
  @ApiPropertyOptional({ description: 'Path mode: the site slug from `/pub/<slug>`' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;

  @ApiPropertyOptional({ description: 'Host mode: the request host, `<slug>.PUBLISH_BASE_DOMAIN`' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({ description: 'The path below the site root, e.g. `/v1.2/guides/install`' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  path?: string;

  @ApiPropertyOptional({ description: 'Switching versions: the page the reader was on, kept when the target version has it' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  from?: string;
}

export class SearchSiteQueryDto {
  @ApiPropertyOptional({ description: 'The words to look for; fewer than 2 characters answers no results' })
  @IsOptional()
  @IsString()
  @MaxLength(SITE_SEARCH_MAX_CHARS)
  q?: string;

  @ApiPropertyOptional({ description: 'A version slug; omitted = the default version' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;
}

export class SiteSessionQueryDto {
  @ApiPropertyOptional({ description: 'A one-time sign-in code from POST /v1/sites/:id/sign-in' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  code?: string;

  @ApiPropertyOptional({ description: 'A visitor JWT (HS256) signed with the site’s visitor secret; `exp` is required' })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  jwt_token?: string;

  @ApiPropertyOptional({ description: 'Where to go afterwards: a path on this same origin. Anything else goes to `/`' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  return?: string;
}

/**
 * A path on the origin the request came in on, or `/`: a protocol-relative
 * `//host`, a backslash (which browsers read as a slash) or anything absolute
 * would make the session route an open redirect.
 */
export function safeReturnPath(raw: string | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw)) return '/';
  return raw;
}

/**
 * What the reader's API answers must not be: cached past an unpublish, or
 * indexed as a page of its own. The site's pages carry their own robots rules,
 * set by the web reader per site.
 */
@Injectable()
class SiteResponseHeaders implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}

/**
 * The anonymous site reader's API (docs/features/44). `@Public()`, rate-limited
 * per address like the share reader; `PublicSitesService` confines every read
 * to a live site's built snapshot, and search reads nothing else. `resolve` is
 * declared before `:siteId`.
 */
@ApiTags('public')
@Controller('v1/public/sites')
@Public()
@UseGuards(PublicRateLimitGuard)
@UseInterceptors(SiteResponseHeaders)
export class PublicSitesController {
  constructor(
    private readonly sites: PublicSitesService,
    private readonly search: PublicSiteSearchService,
    private readonly sessions: SiteSessionService,
  ) {}

  /**
   * Conditional: the web reader sends the ETag of the render it cached, and a
   * 304 lets it serve that render without the page body being read at all
   * (issue #77 phase 2b-2).
   */
  @Get('resolve')
  @ApiOperation({ summary: 'A site, version and page for a slug or host plus a path: everything one render needs' })
  @ApiResponse({ status: 304, description: 'The If-None-Match tag still names this answer' })
  @ApiResponse({ status: 404, description: 'No live site there, or sites are off for its workspace' })
  async resolve(
    @Query() query: ResolveSiteQueryDto,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicSiteResolveResponse | undefined> {
    const { etag, body } = await this.sites.resolveTagged(query, ifNoneMatch, req.headers.cookie);
    res.setHeader('ETag', etag);
    if (!body) {
      res.status(304);
      return undefined;
    }
    return body;
  }

  @Get(':siteId/search')
  @ApiOperation({ summary: "Search one version of a live site: its published pages only, at the revisions it shows" })
  @ApiResponse({ status: 404, description: 'No live site with this id, or no such version' })
  searchSite(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: SearchSiteQueryDto,
    @Req() req: Request,
  ): Promise<PublicSiteSearchResponse> {
    return this.search.search(siteId, query, req.headers.cookie);
  }

  /**
   * Sign in to a site (issue #77 phase 3): spend a member's one-time code or
   * a visitor's JWT, set the site's session cookie on this origin, and go
   * back. Anything that does not check out goes back all the same, signed
   * out: the reader then shows what an anonymous reader sees.
   */
  @Get(':siteId/session')
  @ApiOperation({ summary: 'Exchange a sign-in code or visitor JWT for the site’s session cookie, then redirect back' })
  @ApiResponse({ status: 302, description: 'Back to `return` on this origin, with the cookie set when the code or token was good' })
  @ApiResponse({ status: 404, description: 'No live site with this id' })
  async openSession(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query() query: SiteSessionQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const site = await this.sites.findById(siteId);
    const opened = query.code
      ? await this.sessions.redeemCode(site, query.code)
      : query.jwt_token
        ? await this.sessions.redeemToken(site, query.jwt_token)
        : null;
    if (opened) {
      res.cookie(siteSessionCookieName(site.id), opened.session, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
        path: '/',
        maxAge: opened.ttlMs,
      });
    }
    // The URL carried a code or a token: it must not travel on as a Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, safeReturnPath(query.return));
  }

  @Post(':siteId/session/end')
  @HttpCode(204)
  @ApiOperation({ summary: 'Sign out of the site: the session ends at once and the cookie is cleared' })
  async endSession(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.end(siteId, req.headers.cookie);
    res.clearCookie(siteSessionCookieName(siteId), { path: '/' });
  }

  @Get(':siteId/logo')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect
  async logo(@Param('siteId', ParseUUIDPipe) siteId: string): Promise<{ url: string; statusCode: number }> {
    return { url: await this.sites.logoUrl(siteId), statusCode: 302 };
  }

  @Get(':siteId/versions/:versionId/attachments/:attachmentId')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect
  async attachment(
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: Request,
    @Query('download') download?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.sites.attachmentUrl(siteId, versionId, attachmentId, download === '1' || download === 'true', req.headers.cookie);
    return { url, statusCode: 302 };
  }
}
