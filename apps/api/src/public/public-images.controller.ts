import { Controller, ForbiddenException, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import { Public } from '../auth/access.decorator.js';
import type { Env } from '../config/env.js';
import { sendImage } from '../image-proxy/image-proxy.controller.js';
import { t } from '../i18n/t.js';
import { ImageSigner } from './image-signer.js';
import { PublicRateLimitGuard } from './public-rate-limit.js';

/**
 * The image proxy for readers without a session (#1146): a share link's or
 * published site's external images, by a URL the API signed when it served
 * the page (`imageProxy`). Same fetch as the member route, same inert
 * headers, under the anonymous per-IP budget.
 */
@ApiTags('public')
@Controller('v1/public/images')
@Public()
@UseGuards(PublicRateLimitGuard)
export class PublicImagesController {
  constructor(
    private readonly signer: ImageSigner,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get()
  @ApiOperation({ summary: "An external image from a shared or published page, by the URL the page's answer signed" })
  @ApiQuery({ name: 'url', type: String, description: 'The image address, as a key of the page’s imageProxy' })
  @ApiQuery({ name: 'sig', type: String, description: 'Its signature from imageProxy' })
  @ApiResponse({ status: 403, description: 'The signature is missing or does not match the URL' })
  async image(@Query('url') url: string | undefined, @Query('sig') sig: string | undefined, @Res() res: ExpressResponse): Promise<void> {
    if (!url || !sig || !this.signer.verify(url, sig)) throw new ForbiddenException(t('error.imageProxy.unsigned'));
    await sendImage(url, res, this.config.get('IMAGE_PROXY_ALLOW_PRIVATE_URLS', { infer: true }), 'public, max-age=86400');
  }
}
