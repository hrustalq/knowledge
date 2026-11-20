import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ApiKey } from '@prisma/client';
import { INSTALL_KEY_TTL_MINUTES, apiKeyScopeOf, keyToolsetsOf, type ApiKeyInfo, type CreateApiKeyResponse, type ListApiKeysResponse } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Principal } from './principal.js';
import type { CreateApiKeyDto } from './api-keys.dto.js';
import { t } from '../i18n/t.js';
import { mintToken } from './auth-tokens.js';
import { AuditService } from './audit.service.js';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(principal: Principal): Promise<ListApiKeysResponse> {
    this.requireSession(principal);
    const rows = await this.prisma.apiKey.findMany({
      where: liveRows(principal.userId),
      orderBy: { createdAt: 'desc' },
    });
    return { keys: rows.map(toInfo) };
  }

  /**
   * `install` (#1371) is a setup key: the installer routes only, for
   * INSTALL_KEY_TTL_MINUTES. Its own expiry, so a lifetime asked for beside it
   * is refused rather than silently ignored.
   */
  async create(principal: Principal, dto: CreateApiKeyDto): Promise<CreateApiKeyResponse> {
    if (dto.install && dto.expiresInDays !== undefined) {
      throw new BadRequestException({ statusCode: 400, message: t('error.auth.installKeyExpiry'), reason: 'install-key-expiry' });
    }
    const { token: apiKey, tokenHash: keyHash } = mintToken('kn_', 24);
    const credential = {
      keyHash,
      prefix: apiKey.slice(0, 11),
      ...(dto.install ? { purpose: 'install', expiresAt: new Date(Date.now() + INSTALL_KEY_TTL_MINUTES * 60_000) } : {}),
    };
    const row = await this.insert(principal, dto, credential, { action: 'api-key.created' });
    return { key: toInfo(row), apiKey };
  }

  /**
   * An OAuth grant (#1352): the row a client's tokens resolve through, written
   * by the consent screen with the same checks, cap and audit as a key — and,
   * like a key, only from a session. It has no bearer of its own. The
   * approving session's sign-in is kept on it for enforced SSO.
   */
  async createGrant(principal: Principal, dto: CreateApiKeyDto, oauthClientId: string): Promise<ApiKey> {
    return this.insert(principal, dto, {
      keyHash: null,
      prefix: 'oauth',
      oauthClientId,
      signInMethod: principal.authMethod ?? null,
      signInProviderId: principal.providerId ?? null,
    }, { action: 'oauth.granted' });
  }

  private async insert(
    principal: Principal,
    dto: CreateApiKeyDto,
    credential: Pick<
      Prisma.ApiKeyUncheckedCreateInput,
      'keyHash' | 'prefix' | 'oauthClientId' | 'signInMethod' | 'signInProviderId' | 'purpose' | 'expiresAt'
    >,
    audit: { action: 'api-key.created' | 'oauth.granted' },
  ): Promise<ApiKey> {
    this.requireSession(principal);
    if (dto.workspaceId && !principal.isAdmin) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: dto.workspaceId, userId: principal.userId } },
      });
      if (!member) {
        throw new ForbiddenException(t('error.auth.apiKeyWorkspaceNotMember', { workspaceId: dto.workspaceId }));
      }
    }
    const projectIds = dto.projectIds?.length ? [...new Set(dto.projectIds)] : null;
    if (projectIds) await this.assertProjectPin(principal, dto, projectIds);
    const active = await this.prisma.apiKey.count({ where: liveRows(principal.userId) });
    if (active >= MAX_ACTIVE_KEYS) {
      throw new BadRequestException(t('error.auth.apiKeyLimit', { max: MAX_ACTIVE_KEYS }));
    }

    // A key has the same shape as `make auth-bootstrap`: 24 random bytes, and
    // only the SHA-256 ever reaches PostgreSQL.
    const row = await this.prisma.apiKey.create({
      data: {
        userId: principal.userId,
        name: dto.name,
        scope: dto.scope ?? 'write',
        workspaceId: dto.workspaceId ?? null,
        projectIds: projectIds ?? Prisma.DbNull,
        // No list, or an empty one, is every toolset; a list always holds `core` (#945).
        toolsets: dto.toolsets?.length ? keyToolsetsOf(dto.toolsets)! : Prisma.DbNull,
        expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null,
        ...credential,
      },
    });
    // Filed under the workspace it is pinned to, so that workspace's admins see it (#1251); else a platform event.
    void this.audit.record({
      workspaceId: row.workspaceId,
      actor: principal.userId,
      action: audit.action,
      params: {
        name: row.name,
        prefix: row.prefix,
        scope: row.scope,
        projectIds,
        toolsets: row.toolsets,
        expiresAt: row.expiresAt,
        ...(row.oauthClientId ? { client: row.oauthClientId } : {}),
        ...(row.purpose === 'install' ? { install: true } : {}),
      },
      target: row.id,
      ok: true,
    });
    return row;
  }

  /** Soft: the row stays so a 401 from an old config can still be traced to a name. */
  async revoke(principal: Principal, id: string): Promise<void> {
    this.requireSession(principal);
    const where = { id, userId: principal.userId, revokedAt: null };
    const key = await this.prisma.apiKey.findFirst({ where, select: { name: true, prefix: true, workspaceId: true } });
    const { count } = key ? await this.prisma.apiKey.updateMany({ where, data: { revokedAt: new Date() } }) : { count: 0 };
    if (count === 0) throw new NotFoundException(t('error.auth.apiKeyNotFound', { id }));
    void this.audit.record({
      workspaceId: key!.workspaceId,
      actor: principal.userId,
      action: 'api-key.revoked',
      params: { name: key!.name, prefix: key!.prefix },
      target: id,
      ok: true,
    });
  }

  /**
   * The pre-feature single-key rotation (POST /v1/me/api-key), kept for any
   * script that calls it: revoke everything, mint one full-scope key.
   */
  async rotate(principal: Principal): Promise<CreateApiKeyResponse> {
    this.requireSession(principal);
    // One commit (#816): a failed mint must not leave the caller with no key at all.
    return this.prisma.withTransaction(async () => {
      const { count } = await this.prisma.apiKey.updateMany({
        where: { userId: principal.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count) {
        void this.audit.record({ workspaceId: null, actor: principal.userId, action: 'api-key.revoked', params: { rotated: count }, ok: true });
      }
      return this.create(principal, { name: 'Rotated key' });
    });
  }

  /**
   * A project pin narrows what a `capture` key may propose into (issue #73),
   * and nothing else — so it is refused on any other scope rather than stored
   * as a setting that does nothing. Each project must be one the owner can
   * reach, and inside the workspace pin when there is one.
   */
  private async assertProjectPin(principal: Principal, dto: CreateApiKeyDto, projectIds: string[]): Promise<void> {
    if (dto.scope !== 'capture') throw new BadRequestException(t('error.auth.apiKeyProjectsNeedCapture'));
    const projects = await this.prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, workspaceId: true },
    });
    const reachable = principal.isAdmin
      ? null
      : new Set(
          (
            await this.prisma.workspaceMember.findMany({
              where: { userId: principal.userId, workspaceId: { in: projects.map((p) => p.workspaceId) } },
              select: { workspaceId: true },
            })
          ).map((m) => m.workspaceId),
        );
    for (const id of projectIds) {
      const project = projects.find((p) => p.id === id);
      const ok =
        project &&
        (!dto.workspaceId || project.workspaceId === dto.workspaceId) &&
        (!reachable || reachable.has(project.workspaceId));
      if (!ok) throw new BadRequestException(t('error.auth.apiKeyProjectNotAllowed', { projectId: id }));
    }
  }

  private requireSession(principal: Principal): void {
    if (principal.mode === 'dev') throw new BadRequestException(t('error.auth.noApiKeyInDevMode'));
    if (principal.mode !== 'session') throw new ForbiddenException(t('error.auth.apiKeyNeedsSession'));
  }
}

/**
 * The caller's keys that still count: not revoked, and not a setup key past its
 * hour (#1371) — one is minted per wizard run, so the list and the 50-key cap
 * would otherwise fill with dead ones. An ordinary expired key stays listed, as before.
 */
function liveRows(userId: string): Prisma.ApiKeyWhereInput {
  return { userId, revokedAt: null, OR: [{ purpose: null }, { expiresAt: { gt: new Date() } }] };
}

function toInfo(row: ApiKey): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: apiKeyScopeOf(row.scope),
    workspaceId: row.workspaceId,
    projectIds: projectPinOf(row.projectIds),
    toolsets: keyToolsetsOf(row.toolsets),
    oauth: row.oauthClientId !== null,
    install: row.purpose === 'install',
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `api_keys.project_ids` as a pin: a non-empty list of ids, or null for every project. */
export function projectPinOf(stored: Prisma.JsonValue | null): string[] | null {
  if (!Array.isArray(stored)) return null;
  const ids = stored.filter((v): v is string => typeof v === 'string');
  return ids.length ? ids : null;
}
