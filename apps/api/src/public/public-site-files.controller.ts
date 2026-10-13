import { Controller, Get, NotFoundException, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { etagMatches } from '../ai-readable/render.js';
import { Public } from '../auth/access.decorator.js';
import { t } from '../i18n/t.js';
import { PublicRateLimitGuard } from './public-rate-limit.js';
import { PublicSiteFilesService, type SiteFile } from './public-site-files.service.js';
import { PublicSitesService } from './public-sites.service.js';

export class SiteFileQueryDto {
  @ApiPropertyOptional({ description: 'Path mode: the site slug from `/pub/<slug>`' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  slug?: string;

  @ApiPropertyOptional({ description: 'Host mode: `<slug>.PUBLISH_BASE_DOMAIN`, or a verified custom domain' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  host?: string;

  @ApiPropertyOptional({ description: 'llms.txt / llms-full.txt: a version slug. Omitted: the default version' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  version?: string;
}

export class SitePageMarkdownQueryDto extends SiteFileQueryDto {
  @ApiPropertyOptional({ description: 'The page path below the site root without `.md`, e.g. `v1/guides/install`; `index` is a version’s home' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  path?: string;
}

export class DomainAllowQueryDto {
  @ApiPropertyOptional({ description: 'The hostname Caddy is about to request a certificate for' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  domain?: string;
}

/**
 * The same file to everyone, revalidated on every use: an unpublish must end
 * it at once, and a 304 against the snapshot's ETag costs one row read.
 */
function send(res: Response, file: SiteFile, contentType: string, opts: { noindex?: boolean } = {}): void {
  res.setHeader('ETag', file.etag);
  res.setHeader('Cache-Control', 'public, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (opts.noindex) res.setHeader('X-Robots-Tag', 'noindex');
  if (file.body === null) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Type', contentType);
  res.status(200).send(file.body);
}

/**
 * A published site's machine-readable files (docs/features/44, issue #77
 * phase 2b), which the web reader proxies at the site's own paths
 * (`/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/llms-full.txt`, `/<page>.md`).
 * `@Public()` and rate-limited like the reader; the same 404 as `resolve` for
 * a site that is not live. Literal routes, no `:param` — they sit beside
 * PublicSitesController's `:siteId/…` without overlapping.
 */
@ApiTags('public')
@Controller('v1/public/sites')
@Public()
@UseGuards(PublicRateLimitGuard)
export class PublicSiteFilesController {
  constructor(private readonly files: PublicSiteFilesService) {}

  @Get('sitemap.xml')
  @ApiProduces('application/xml')
  @ApiOperation({ summary: 'sitemap.xml of the default version, absolute canonical URLs. 404 when the site is not indexable' })
  @ApiResponse({ status: 304, description: 'Unchanged since the ETag sent in If-None-Match' })
  async sitemap(@Query() query: SiteFileQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    send(res, await this.files.sitemap(query, req.headers['if-none-match']), 'application/xml; charset=utf-8');
  }

  @Get('robots.txt')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'robots.txt: allow everything with the sitemap, or disallow everything when the site is not indexable' })
  async robots(@Query() query: SiteFileQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    send(res, await this.files.robots(query, req.headers['if-none-match']), 'text/plain; charset=utf-8');
  }

  @Get('llms.txt')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'llms.txt of a version: its pages as markdown links in reading order, then the other versions' })
  async llms(@Query() query: SiteFileQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    send(res, await this.files.llmsIndex(query, req.headers['if-none-match']), 'text/plain; charset=utf-8', { noindex: true });
  }

  @Get('llms-full.txt')
  @ApiProduces('text/plain')
  @ApiOperation({ summary: 'Every page of a version at its published revision, concatenated and streamed (LLMS_FULL_MAX_DOCS / _BYTES)' })
  async llmsFull(@Query() query: SiteFileQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    const plan = await this.files.llmsFullPlan(query);
    res.setHeader('ETag', plan.etag);
    res.setHeader('Cache-Control', 'public, no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex');
    if (etagMatches(req.headers['if-none-match'], plan.etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200);
    await this.files.streamFull(plan, res);
    res.end();
  }

  @Get('markdown')
  @ApiProduces('text/markdown')
  @ApiOperation({ summary: 'One page as markdown at its published revision (the reader serves it at `<page>.md`)' })
  @ApiResponse({ status: 404, description: 'No live site there, or no page at that path' })
  async markdown(@Query() query: SitePageMarkdownQueryDto, @Req() req: Request, @Res() res: Response): Promise<void> {
    send(res, await this.files.markdown(query, req.headers['if-none-match']), 'text/markdown; charset=utf-8', { noindex: true });
  }
}

/**
 * Caddy's on-demand TLS `ask` (Caddyfile.sites.example). Caddy calls it
 * before requesting a certificate for a hostname it has not seen: 200 lets
 * it, anything else refuses. Rate-limited per caller like every public route.
 */
@ApiTags('public')
@Controller('v1/public/domains')
@Public()
@UseGuards(PublicRateLimitGuard)
export class PublicDomainsController {
  constructor(private readonly sites: PublicSitesService) {}

  @Get('allow')
  @ApiOperation({ summary: 'May a TLS certificate be issued for this hostname? 200 for a site’s subdomain or verified custom domain' })
  @ApiOkResponse({ description: 'The hostname belongs to a site' })
  @ApiResponse({ status: 404, description: 'Not a hostname this platform serves' })
  async allow(@Query() query: DomainAllowQueryDto): Promise<{ allowed: true }> {
    if (!query.domain || !(await this.sites.hostAllowed(query.domain))) throw new NotFoundException(t('error.site.notFound'));
    return { allowed: true };
  }
}
