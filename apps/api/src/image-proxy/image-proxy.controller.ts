import { BadGatewayException, BadRequestException, Controller, ForbiddenException, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import type { Env } from '../config/env.js';
import { readCapped } from '../common/read-capped.js';
import { safeFetch } from '../common/safe-fetch.js';
import { t } from '../i18n/t.js';

/** What a page may hotlink. SVG too: README badges are SVG, and RESPONSE_HEADERS keeps one opened directly inert. */
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
]);

// ponytail: fixed ceilings, env knobs when a real page needs a bigger or slower image.
const MAX_BYTES = 10_000_000;
const TIMEOUT_MS = 10_000;

/**
 * Served from the app's own origin, so an image must stay an image: a proxied
 * SVG opened in a tab runs no script and loads nothing (`sandbox`,
 * `default-src 'none'`), `nosniff` comes from `applySecurityHeaders`, and
 * another site cannot embed the proxy under the reader's cookie.
 */
const RESPONSE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * External images in pages, fetched by the API (#1133), so the member app's
 * CSP can hold `img-src` to its own origin and a hotlinked image is no longer
 * a tracking pixel aimed at the reader.
 *
 * Not `@Access`-guarded: no workspace owns a URL. Any signed-in principal may
 * ask (the session cookie rides an `<img>`), and the upstream request carries
 * none of theirs — no cookie, no referrer, a fixed user agent. `safeFetch`
 * refuses a private address on every hop, inside the socket's own lookup.
 * Share links and published sites reach the same fetch through
 * `GET /v1/public/images`, which takes a URL the API signed instead (#1146).
 */
@ApiTags('image-proxy')
@Controller('v1/image-proxy')
export class ImageProxyController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Get()
  @ApiOperation({ summary: 'An external image from a page, fetched through the API (member app only)' })
  @ApiQuery({ name: 'url', type: String, description: 'The http(s) address of the image' })
  async image(@Query('url') raw: string | undefined, @Res() res: ExpressResponse): Promise<void> {
    await sendImage(raw, res, this.config.get('IMAGE_PROXY_ALLOW_PRIVATE_URLS', { infer: true }), 'private, max-age=86400');
  }
}

/**
 * Fetch `raw` and answer with it as an inert image, or throw. Shared with the
 * signed public route (`PublicImagesController`, #1146), which differs only in
 * who may ask and in a `public` cache.
 */
export async function sendImage(raw: string | undefined, res: ExpressResponse, allowPrivate: boolean, cacheControl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    throw new BadRequestException(t('error.imageProxy.invalid'));
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException(t('error.imageProxy.invalid'));

  let upstream: Response;
  try {
    upstream = await safeFetch(
      url,
      { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'image/*', 'user-agent': 'knowledge-image-proxy' } },
      allowPrivate,
    );
  } catch (err) {
    if ((err as { cause?: { code?: string } }).cause?.code === 'EBLOCKEDADDRESS') {
      throw new ForbiddenException(t('error.imageProxy.blocked'));
    }
    throw new BadGatewayException(t('error.imageProxy.unavailable'));
  }

  const type = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!upstream.ok || !IMAGE_TYPES.has(type)) {
    await upstream.body?.cancel().catch(() => {});
    throw new BadGatewayException(t('error.imageProxy.unavailable'));
  }
  const { bytes, whole } = await readCapped(upstream, MAX_BYTES);
  if (!whole) throw new BadGatewayException(t('error.imageProxy.unavailable'));

  res.set({ ...RESPONSE_HEADERS, 'Cache-Control': cacheControl, 'Content-Type': type }).send(Buffer.from(bytes));
}
