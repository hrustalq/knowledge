import { createHash, createHmac, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { publicImageKeys } from '@knowledge/contracts/publishing';
import type { Env } from '../config/env.js';
import { verifyHmacSha256 } from '../common/hmac.js';

/**
 * Signs the external URLs of a public page (#1146), so `GET /v1/public/images`
 * fetches only what a share or site actually shows. No expiry: a site's
 * render is cached by ETag and a frozen version never changes, so the same
 * URL must sign the same way for as long as the key does.
 *
 * The key is derived from SETTINGS_ENCRYPTION_KEY, as analytics derives its
 * reader key; with none set it is per process, so signed URLs die with it.
 */
@Injectable()
export class ImageSigner {
  private readonly secret: string;

  constructor(config: ConfigService<Env, true>) {
    const settings = config.get('SETTINGS_ENCRYPTION_KEY', { infer: true });
    if (settings) this.secret = createHash('sha256').update(`image-proxy:${settings}`).digest('hex');
    else {
      this.secret = randomBytes(32).toString('hex');
      new Logger(ImageSigner.name).warn('SETTINGS_ENCRYPTION_KEY is empty: public image URLs are signed per process');
    }
  }

  sign(key: string): string {
    return createHmac('sha256', this.secret).update(key, 'utf8').digest('hex');
  }

  verify(key: string, signature: string): boolean {
    return verifyHmacSha256(key, this.secret, signature);
  }

  /** A public page body's `imageProxy`: every key its images can have, signed. */
  signAll(markdown: string): Record<string, string> {
    return Object.fromEntries(publicImageKeys(markdown).map((key) => [key, this.sign(key)]));
  }
}
