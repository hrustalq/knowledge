import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PublicStore } from './public-store.js';

const KEY_PREFIX = 'kn:share-unlock:';

/** The cookie that carries one browser's unlock of one link. */
export function unlockCookieName(shareId: string): string {
  return `kn_share_${shareId}`;
}

/** Minimal cookie read; the API installs no cookie parser. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Bound to the password as it is now, so changing (or clearing and setting)
 * it ends every open session at once: the stored fingerprint stops matching.
 */
function passwordFingerprint(passwordHash: string): string {
  return createHash('sha256').update(passwordHash).digest('hex').slice(0, 32);
}

/**
 * Password-unlocked share sessions (docs/features/43).
 *
 * The cookie holds a random value; Redis maps its SHA-256 to
 * `shareId|fingerprint` for SHARE_UNLOCK_TTL_MIN. Server-side rather than a
 * signed cookie because the deployment has no signing secret to rely on
 * (SETTINGS_ENCRYPTION_KEY is optional), and because the check must see the
 * link's current password, not the one the cookie was issued under.
 */
@Injectable()
export class ShareUnlockService {
  private readonly logger = new Logger(ShareUnlockService.name);
  readonly ttlMs: number;

  constructor(
    private readonly store: PublicStore,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('SHARE_UNLOCK_TTL_MIN', { infer: true }) * 60_000;
  }

  private key(session: string): string {
    return KEY_PREFIX + createHash('sha256').update(session).digest('hex');
  }

  /** A new session for this link and password; the value goes into the cookie. */
  async open(shareId: string, passwordHash: string): Promise<string> {
    const session = randomBytes(24).toString('base64url');
    await this.store.kv.set(this.key(session), `${shareId}|${passwordFingerprint(passwordHash)}`, 'PX', this.ttlMs);
    return session;
  }

  /** Does the request carry an open session for this link under its current password? */
  async isUnlocked(shareId: string, passwordHash: string, cookieHeader: string | undefined): Promise<boolean> {
    const session = readCookie(cookieHeader, unlockCookieName(shareId));
    if (!session) return false;
    try {
      const value = await this.store.kv.get(this.key(session));
      return value === `${shareId}|${passwordFingerprint(passwordHash)}`;
    } catch (err) {
      // Locked is the safe reading of an outage: the gate shows, nothing leaks.
      this.logger.warn({ msg: 'unlock store unavailable', shareId, err });
      return false;
    }
  }
}
