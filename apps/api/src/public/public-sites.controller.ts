import {
  Controller,
  Get,
  Injectable,
  Param,
  Query,
  Redirect,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiPropertyOptional, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { PublicSiteResolveResponse } from '@knowledge/contracts';
import { Public } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { PublicRateLimitGuard } from './public-rate-limit.js';
import { PublicSitesService } from './public-sites.service.js';

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
 * to a live site's built snapshot. `resolve` is declared before `:siteId`.
 */
@ApiTags('public')
@Controller('v1/public/sites')
@Public()
@UseGuards(PublicRateLimitGuard)
@UseInterceptors(SiteResponseHeaders)
export class PublicSitesController {
  constructor(private readonly sites: PublicSitesService) {}

  @Get('resolve')
  @ApiOperation({ summary: 'A site, version and page for a slug or host plus a path: everything one render needs' })
  @ApiResponse({ status: 404, description: 'No live site there, or sites are off for its workspace' })
  resolve(@Query() query: ResolveSiteQueryDto): Promise<PublicSiteResolveResponse> {
    return this.sites.resolve(query);
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
    @Query('download') download?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.sites.attachmentUrl(siteId, versionId, attachmentId, download === '1' || download === 'true');
    return { url, statusCode: 302 };
  }
}
