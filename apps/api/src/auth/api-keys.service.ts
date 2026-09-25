import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiKey } from '@prisma/client';
import type { ApiKeyInfo, CreateApiKeyResponse, ListApiKeysResponse } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Principal } from './principal.js';
import type { CreateApiKeyDto } from './api-keys.dto.js';
import { t } from '../i18n/t.js';

/** Plenty for "one per machine per client"; a ceiling so a script loop cannot fill the table. */
const MAX_ACTIVE_KEYS = 50;

/**
 * Named `kn_` API keys (docs/features/33).
 *
 * Every method acts on the caller and takes no user id, like MeController. And
 * every method refuses to be driven by an API key: a leaked key that could
 * mint its own replacements, or widen itself, would survive being revoked.
 */
@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  async list(principal: Principal): Promise<ListApiKeysResponse> {
    this.requireSession(principal);
    const rows = await this.prisma.apiKey.findMany({
      where: { userId: principal.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return { keys: rows.map(toInfo) };
  }

  async create(principal: Principal, dto: CreateApiKeyDto): Promise<CreateApiKeyResponse> {
    this.requireSession(principal);
    if (dto.workspaceId && !principal.isAdmin) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: dto.workspaceId, userId: principal.userId } },
      });
      if (!member) {
        throw new ForbiddenException(t('error.auth.apiKeyWorkspaceNotMember', { workspaceId: dto.workspaceId }));
      }
    }
    const active = await this.prisma.apiKey.count({ where: { userId: principal.userId, revokedAt: null } });
    if (active >= MAX_ACTIVE_KEYS) {
      throw new BadRequestException(t('error.auth.apiKeyLimit', { max: MAX_ACTIVE_KEYS }));
    }

    // Same shape as `make auth-bootstrap`: 24 random bytes, and only the
    // SHA-256 ever reaches PostgreSQL.
    const apiKey = `kn_${randomBytes(24).toString('hex')}`;
    const row = await this.prisma.apiKey.create({
      data: {
        userId: principal.userId,
        name: dto.name,
        keyHash: createHash('sha256').update(apiKey).digest('hex'),
        prefix: apiKey.slice(0, 11),
        scope: dto.scope ?? 'write',
        workspaceId: dto.workspaceId ?? null,
        expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null,
      },
    });
    return { key: toInfo(row), apiKey };
  }

  /** Soft: the row stays so a 401 from an old config can still be traced to a name. */
  async revoke(principal: Principal, id: string): Promise<void> {
    this.requireSession(principal);
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id, userId: principal.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException(t('error.auth.apiKeyNotFound', { id }));
  }

  /**
   * The pre-feature single-key rotation (POST /v1/me/api-key), kept for any
   * script that calls it: revoke everything, mint one full-scope key.
   */
  async rotate(principal: Principal): Promise<CreateApiKeyResponse> {
    this.requireSession(principal);
    await this.prisma.apiKey.updateMany({
      where: { userId: principal.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return this.create(principal, { name: 'Rotated key' });
  }

  private requireSession(principal: Principal): void {
    if (principal.mode === 'dev') throw new BadRequestException(t('error.auth.noApiKeyInDevMode'));
    if (principal.mode !== 'session') throw new ForbiddenException(t('error.auth.apiKeyNeedsSession'));
  }
}

function toInfo(row: ApiKey): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope === 'read' ? 'read' : 'write',
    workspaceId: row.workspaceId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
