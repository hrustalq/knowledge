import {
  Body,
  Controller,
  Get,
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
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import type { PublicShareExport, PublicSharePage, PublicShareResponse } from '@knowledge/contracts';
import { Public } from '../auth/access.decorator.js';
import { ParseUuidPipe as ParseUUIDPipe } from '../common/validation.js';
import { CreateShareExportDto, UnlockShareDto } from '../publishing/share-links.dto.js';
import { PublicRateLimitGuard } from './public-rate-limit.js';
import { PublicSharesService } from './public-shares.service.js';
import { unlockCookieName } from './share-unlock.service.js';

/**
 * Set on every share response, errors included (the filter writes onto the
 * same response object): the token is in the URL, so no Referer may carry it
 * on; a shared page is never search-indexed; and nothing may cache an answer
 * that a revoke must end at once.
 */
@Injectable()
class ShareResponseHeaders implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}

/**
 * The anonymous reader's API (docs/features/43). `@Public()`: there is no
 * principal and no workspace to resolve; the token is the whole credential,
 * and `PublicSharesService` confines every read to the scope it names.
 * Literal segments (`unlock`, `pages`, `attachments`, `exports`) sit after
 * `:token`, so none competes with it.
 */
@ApiTags('public')
@Controller('v1/public/shares')
@Public()
@UseGuards(PublicRateLimitGuard)
@UseInterceptors(ShareResponseHeaders)
export class PublicSharesController {
  constructor(private readonly shares: PublicSharesService) {}

  @Get(':token')
  @ApiOperation({ summary: 'A shared page: its title and the pages the link reaches, or `locked` when a password is needed' })
  @ApiResponse({ status: 404, description: 'Unknown, revoked or expired link, or sharing is off' })
  view(@Param('token') token: string, @Req() req: Request): Promise<PublicShareResponse> {
    return this.shares.view(token, req.headers.cookie);
  }

  @Post(':token/unlock')
  @HttpCode(204)
  @ApiOperation({ summary: 'Enter a link’s password; sets an httpOnly cookie for SHARE_UNLOCK_TTL_MIN' })
  @ApiResponse({ status: 401, description: 'Wrong password' })
  @ApiResponse({ status: 429, description: 'Too many attempts from this address' })
  async unlock(
    @Param('token') token: string,
    @Body() dto: UnlockShareDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { shareId, session, ttlMs } = await this.shares.unlock(token, dto.password, req);
    if (!session) return;
    res.cookie(unlockCookieName(shareId), session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      path: '/',
      maxAge: ttlMs,
    });
  }

  @Get(':token/pages/:documentId')
  @ApiOperation({ summary: 'One page the link reaches: title and markdown body, frontmatter stripped' })
  @ApiResponse({ status: 404, description: 'Not a page this link reaches' })
  page(
    @Param('token') token: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: Request,
  ): Promise<PublicSharePage> {
    return this.shares.page(token, documentId, req.headers.cookie);
  }

  @Post(':token/exports')
  @ApiOperation({ summary: 'Export what the link shows as ZIP, HTML or PDF, when the link allows download (#161); poll the job' })
  @ApiResponse({ status: 404, description: 'Dead link, or download is off' })
  @ApiResponse({ status: 401, description: 'The link is locked: unlock it first' })
  @ApiResponse({ status: 429, description: 'Too many exports from this address or link (details.reason share.exportRateLimited)' })
  @ApiResponse({ status: 409, description: 'PDF without Gotenberg (details.reason export.formatUnavailable)' })
  createExport(@Param('token') token: string, @Body() dto: CreateShareExportDto, @Req() req: Request): Promise<PublicShareExport> {
    return this.shares.createExport(token, dto.format, req);
  }

  @Get(':token/exports/:exportId')
  @ApiOperation({ summary: 'One of this link’s exports — polled while it runs' })
  @ApiResponse({ status: 404, description: 'Dead link, download off, or not this link’s export' })
  getExport(
    @Param('token') token: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @Req() req: Request,
  ): Promise<PublicShareExport> {
    return this.shares.getExport(token, exportId, req.headers.cookie);
  }

  /**
   * A 302 to a short-lived URL, like an attachment: the reader's browser
   * follows a plain link, with the unlock cookie and no header to add.
   */
  @Get(':token/exports/:exportId/download')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect; not useful in the generated client
  async exportDownload(
    @Param('token') token: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @Req() req: Request,
  ): Promise<{ url: string; statusCode: number }> {
    const { url } = await this.shares.exportDownload(token, exportId, req.headers.cookie);
    return { url, statusCode: 302 };
  }

  @Get(':token/attachments/:attachmentId')
  @Redirect(undefined, 302)
  @ApiExcludeEndpoint() // binary redirect; not useful in the generated client
  async attachment(
    @Param('token') token: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: Request,
    @Query('download') download?: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.shares.attachmentUrl(token, attachmentId, download === '1' || download === 'true', req.headers.cookie);
    return { url, statusCode: 302 };
  }
}
