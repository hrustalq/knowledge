import { randomBytes } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ScimToken } from '@prisma/client';
import type { ScimDefaultRole, ScimSettingsView, ScimTokenCreated, ScimTokenView } from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { Principal } from '../auth/principal.js';
import { RoleSyncService, scimDefaultRoleOf } from '../auth/sso/role-sync.service.js';
import { hashScimToken, SCIM_TOKEN_PREFIX } from './scim-token.guard.js';
import { ScimService } from './scim.service.js';

/** Live tokens per workspace: one per IdP, plus room to rotate. */
const MAX_ACTIVE_TOKENS = 10;

const view = (r: ScimToken): ScimTokenView => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
});

/**
 * A workspace's SCIM side (#75 phase 5), Settings → Security → Provisioning:
 * the base URL to give the IdP, its bearer tokens (the secret shown once,
 * only the SHA-256 kept), and the role a provisioned person gets without a
 * mapped group.
 */
@Injectable()
export class ScimTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly roleSync: RoleSyncService,
    private readonly scim: ScimService,
  ) {}

  async view(workspaceId: string): Promise<ScimSettingsView> {
    const [tokens, settings, users, activeUsers, groups] = await Promise.all([
      this.prisma.scimToken.findMany({ where: { workspaceId, revokedAt: null }, orderBy: { createdAt: 'desc' } }),
      this.prisma.workspaceSettings.findUnique({ where: { workspaceId } }),
      this.prisma.scimUser.count({ where: { workspaceId } }),
      this.prisma.scimUser.count({ where: { workspaceId, active: true } }),
      this.prisma.scimGroup.count({ where: { workspaceId } }),
    ]);
    return {
      workspaceId,
      baseUrl: this.scim.base,
      defaultRole: scimDefaultRoleOf(settings?.scimDefaultRole),
      tokens: tokens.map(view),
      users,
      activeUsers,
      groups,
    };
  }

  /** Changing the default re-syncs every provisioned person whose role it decides. */
  async putSettings(workspaceId: string, defaultRole: ScimDefaultRole, principal: Principal): Promise<ScimSettingsView> {
    const before = await this.prisma.workspaceSettings.findUnique({ where: { workspaceId } });
    await this.prisma.workspaceSettings.upsert({
      where: { workspaceId },
      create: { workspaceId, scimDefaultRole: defaultRole, updatedBy: principal.userId },
      update: { scimDefaultRole: defaultRole, updatedBy: principal.userId },
    });
    const from = scimDefaultRoleOf(before?.scimDefaultRole);
    if (from !== defaultRole) {
      const people = await this.prisma.scimUser.findMany({ where: { workspaceId }, select: { userId: true } });
      await this.roleSync.applyScim(workspaceId, people.map((p) => p.userId));
    }
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'scim.settings_updated',
      params: { defaultRole: { from, to: defaultRole } },
      ok: true,
    });
    return this.view(workspaceId);
  }

  async create(workspaceId: string, name: string, principal: Principal): Promise<ScimTokenCreated> {
    const active = await this.prisma.scimToken.count({ where: { workspaceId, revokedAt: null } });
    if (active >= MAX_ACTIVE_TOKENS) throw new BadRequestException(t('error.scim.tokenLimit', { max: MAX_ACTIVE_TOKENS }));
    const secret = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    const row = await this.prisma.scimToken.create({
      data: { workspaceId, name, tokenHash: hashScimToken(secret), prefix: secret.slice(0, SCIM_TOKEN_PREFIX.length + 8) },
    });
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'scim.token_created',
      params: { name, prefix: row.prefix },
      ok: true,
      target: row.id,
    });
    return { token: view(row), secret };
  }

  /** Soft, like API keys: the row stays so a 401 in the IdP's log can still be traced to a name. */
  async revoke(workspaceId: string, tokenId: string, principal: Principal): Promise<void> {
    const { count } = await this.prisma.scimToken.updateMany({
      where: { id: tokenId, workspaceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!count) throw new NotFoundException(t('error.scim.tokenNotFound'));
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'scim.token_revoked',
      params: {},
      ok: true,
      target: tokenId,
    });
  }
}
