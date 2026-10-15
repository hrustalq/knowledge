import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { siteSessionCookieName, type SiteViewer } from '@knowledge/contracts';
import { decryptSecret, parseKey } from '../ai/secret-box.js';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublicStore } from './public-store.js';
import { readCookie } from './share-unlock.service.js';

const SESSION_PREFIX = 'kn:site-session:';
const CODE_PREFIX = 'kn:site-code:';

/** How long a sign-in code lives between the app and the site: one redirect. */
export const SITE_SIGN_IN_CODE_TTL_MS = 2 * 60_000;

/** Largest visitor token looked at; a JWT this size is not a sign-in, it is a payload. */
const MAX_TOKEN_CHARS = 8_192;

/** The dev principal's id (AUTH_MODE=none), which has no membership row. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

type StoredSession =
  | { siteId: string; kind: 'member'; userId: string }
  | { siteId: string; kind: 'visitor'; claims: Record<string, unknown>; secret: string };

/** What a session's check needs to know about its site. */
export interface SessionSite {
  id: string;
  workspaceId: string;
  visitorSecretCipher: string | null;
}

/**
 * The secret a visitor session was opened under, as a fingerprint of its
 * stored envelope: rotating or clearing the secret changes it, which ends
 * every visitor session at once.
 */
export function secretFingerprint(cipher: string): string {
  return createHash('sha256').update(cipher).digest('hex').slice(0, 32);
}

/**
 * An HS256 JWT's claims when the signature is the site's and the token is
 * current: `exp` is required (a token that never expires is a password, not a
 * sign-in), `nbf` is honoured. Anything else — another algorithm, `none`, a
 * malformed part — is null, and the reader stays anonymous.
 */
export function verifyVisitorToken(token: string, secret: string, now = Date.now()): Record<string, unknown> | null {
  if (!token || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
    if (header.alg !== 'HS256') return null;
    const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
    const given = Buffer.from(signatureB64, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const claims = payload as Record<string, unknown>;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Who is reading a published site (issue #77 phase 3, docs/features/44).
 *
 * A sign-in is a random value in the `kn_site_<siteId>` cookie on the site's
 * own origin; Redis maps its SHA-256 to the session for SITE_VISITOR_TTL_MIN.
 * Server-side, like share unlocks, so the check can see the world as it is
 * now: a member's session is only good while the person still has a role in
 * the workspace and an enabled account, and a visitor's while the site still
 * has the secret the token was signed with. Nothing about a session is
 * trusted from the cookie but its key.
 *
 * Every failure — no cookie, an unknown or expired value, a store outage — is
 * an anonymous reader, which sees the public pages and nothing else.
 */
@Injectable()
export class SiteSessionService {
  private readonly logger = new Logger(SiteSessionService.name);
  readonly ttlMs: number;

  constructor(
    private readonly store: PublicStore,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('SITE_VISITOR_TTL_MIN', { infer: true }) * 60_000;
  }

  /** A one-time code that signs `userId` in to this site; the API's `sign-in` route hands it to the browser. */
  async issueCode(siteId: string, userId: string): Promise<string> {
    const code = randomBytes(24).toString('base64url');
    await this.store.kv.set(this.key(CODE_PREFIX, code), JSON.stringify({ siteId, userId }), 'PX', SITE_SIGN_IN_CODE_TTL_MS);
    return code;
  }

  /** Spend a code: a session value for the member it named, or null when it is unknown, used, expired or another site's. */
  async redeemCode(site: SessionSite, code: string): Promise<{ session: string; ttlMs: number } | null> {
    if (!code || code.length > 100) return null;
    const raw = await this.store.kv.getdel(this.key(CODE_PREFIX, code));
    const issued = parse<{ siteId: string; userId: string }>(raw);
    if (!issued || issued.siteId !== site.id || !(await this.isMember(site.workspaceId, issued.userId))) return null;
    return { session: await this.open({ siteId: site.id, kind: 'member', userId: issued.userId }, this.ttlMs), ttlMs: this.ttlMs };
  }

  /** Exchange a customer-signed JWT for a session, held to the shorter of the token's `exp` and SITE_VISITOR_TTL_MIN. */
  async redeemToken(site: SessionSite, token: string): Promise<{ session: string; ttlMs: number } | null> {
    const secret = this.visitorSecret(site);
    if (!secret || !site.visitorSecretCipher) return null;
    const claims = verifyVisitorToken(token, secret);
    if (!claims) return null;
    const ttlMs = Math.min(this.ttlMs, (claims.exp as number) * 1000 - Date.now());
    if (ttlMs <= 0) return null;
    const session = await this.open(
      { siteId: site.id, kind: 'visitor', claims, secret: secretFingerprint(site.visitorSecretCipher) },
      ttlMs,
    );
    return { session, ttlMs };
  }

  /** Who the request's cookie says is reading this site. */
  async viewer(site: SessionSite, cookieHeader: string | undefined): Promise<SiteViewer> {
    const anonymous: SiteViewer = { kind: 'anonymous' };
    const value = readCookie(cookieHeader, siteSessionCookieName(site.id));
    if (!value) return anonymous;
    try {
      const stored = parse<StoredSession>(await this.store.kv.get(this.key(SESSION_PREFIX, value)));
      if (!stored || stored.siteId !== site.id) return anonymous;
      if (stored.kind === 'member') {
        return (await this.isMember(site.workspaceId, stored.userId)) ? { kind: 'member' } : anonymous;
      }
      if (stored.kind === 'visitor' && site.visitorSecretCipher && stored.secret === secretFingerprint(site.visitorSecretCipher)) {
        return { kind: 'visitor', claims: stored.claims };
      }
      return anonymous;
    } catch (err) {
      // Anonymous is the safe reading of an outage: public pages still show.
      this.logger.warn({ msg: 'site session store unavailable', siteId: site.id, err });
      return anonymous;
    }
  }

  /** Sign out: the session is gone at once, whatever the cookie does next. */
  async end(siteId: string, cookieHeader: string | undefined): Promise<void> {
    const value = readCookie(cookieHeader, siteSessionCookieName(siteId));
    if (value) await this.store.kv.del(this.key(SESSION_PREFIX, value)).catch(() => 0);
  }

  // -------------------------------------------------------------------------

  private key(prefix: string, value: string): string {
    return prefix + createHash('sha256').update(value).digest('hex');
  }

  private async open(session: StoredSession, ttlMs: number): Promise<string> {
    const value = randomBytes(24).toString('base64url');
    await this.store.kv.set(this.key(SESSION_PREFIX, value), JSON.stringify(session), 'PX', Math.max(1, Math.floor(ttlMs)));
    return value;
  }

  private visitorSecret(site: SessionSite): string | null {
    return decryptSecret(site.visitorSecretCipher, parseKey(this.config.get('SETTINGS_ENCRYPTION_KEY', { infer: true })));
  }

  /**
   * A role in the workspace — guests excluded, since a members-only site is
   * the workspace's pages and a guest reads only what was granted (#76) — and
   * an account that is not disabled. AUTH_MODE=none has one person, the dev
   * principal, who is everyone.
   */
  private async isMember(workspaceId: string, userId: string): Promise<boolean> {
    if (this.config.get('AUTH_MODE', { infer: true }) === 'none') return true;
    if (userId === AUTHOR_ID_STUB) return false;
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, user: { select: { disabledAt: true } } },
    });
    if (member?.role === 'guest') return false;
    if (member) return !member.user.disabledAt;
    // A platform admin is implicitly an admin of every workspace.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true, disabledAt: true } });
    return !!user?.isAdmin && !user.disabledAt;
  }
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
