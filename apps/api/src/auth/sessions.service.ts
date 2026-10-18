import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Session, User } from '@prisma/client';
import { authMethodOf, type AuthMethod, type SessionView } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * What a new session records about how it was opened (#75). Every field is
 * optional so a caller that knows nothing yet still gets today's session: a
 * password login with no metadata.
 */
export interface SessionMeta {
  authMethod?: AuthMethod;
  providerId?: string | null;
  /** The IdP's session id (OIDC `sid`), for back-channel logout. */
  idpSessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Overrides AUTH_SESSION_TTL_HOURS — a provider's own session lifetime. */
  ttlHours?: number | null;
}

/** last_seen_at is written at most this often per session; a page load makes many requests. */
const TOUCH_EVERY_MS = 60_000;

/**
 * Auth flow: opaque `ks_` login session tokens. Same storage rule as API keys —
 * only the SHA-256 of the token ever lands in PostgreSQL.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async create(userId: string, meta: SessionMeta = {}): Promise<{ token: string; session: Session }> {
    // Opportunistic cleanup — no cron needed for a table this small.
    await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const token = `ks_${randomBytes(32).toString('hex')}`;
    const ttlHours = meta.ttlHours ?? this.config.get<number>('AUTH_SESSION_TTL_HOURS') ?? 720;
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
        authMethod: meta.authMethod ?? 'password',
        providerId: meta.providerId ?? null,
        idpSessionId: meta.idpSessionId ?? null,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });
    return { token, session };
  }

  /** Resolve a live (unexpired, unrevoked) session together with its user. */
  async resolve(token: string): Promise<(Session & { user: User }) | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: this.hash(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
    return session;
  }

  /**
   * last_seen_at, at most once a minute per session — the same guarded,
   * fire-and-forget statement as an API key's last_used_at. Bookkeeping never
   * fails a request.
   */
  touch(sessionId: string, now = new Date()): void {
    const stale = new Date(now.getTime() - TOUCH_EVERY_MS);
    void this.prisma.session
      .updateMany({
        where: { id: sessionId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: stale } }] },
        data: { lastSeenAt: now },
      })
      .catch(() => undefined);
  }

  /** A user's live sessions, newest first. `currentId` marks the one asking. */
  async listForUser(userId: string, currentId?: string): Promise<SessionView[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((s) => ({
      id: s.id,
      authMethod: authMethodOf(s.authMethod),
      providerId: s.providerId,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === currentId,
    }));
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoke one session only if it belongs to `userId`. One guarded statement,
   * so another person's session id is indistinguishable from an unknown one.
   */
  async revokeOwn(userId: string, sessionId: string): Promise<boolean> {
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count > 0;
  }

  /** Revoke every live session of a user (password reset / disable), optionally keeping one. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<number> {
    const { count } = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
    return count;
  }
}
