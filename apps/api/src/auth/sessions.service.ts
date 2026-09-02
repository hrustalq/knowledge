import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Session, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

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

  async create(userId: string): Promise<{ token: string; session: Session }> {
    // Opportunistic cleanup — no cron needed for a table this small.
    await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const token = `ks_${randomBytes(32).toString('hex')}`;
    const ttlHours = this.config.get<number>('AUTH_SESSION_TTL_HOURS') ?? 720;
    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + ttlHours * 3600_000),
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

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Revoke every live session of a user (password reset / disable), optionally keeping one. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }
}
