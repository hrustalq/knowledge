import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type IdentityProvider, type IdpGroupMapping } from '@prisma/client';
import {
  GROUP_SYNC_MODES,
  WORKSPACE_ROLES,
  type GroupMappingView,
  type GroupSyncMode,
  type ListGroupMappingsResponse,
  type WorkspaceRole,
} from '@knowledge/contracts';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { t } from '../../i18n/t.js';
import { SCIM_TX, scimEnabled } from '../../scim/scim-enabled.js';
import { AuditService } from '../audit.service.js';
import type { Principal } from '../principal.js';
import type { UpsertGroupMappingDto } from './identity-providers.dto.js';
import { RoleSyncService } from './role-sync.service.js';
import { ssoEnabled } from './sso-enabled.guard.js';

/**
 * A workspace's group → role mappings (#75 phases 3 and 5), Settings →
 * Security → Group mapping. Two kinds share the table:
 *
 * - a provider mapping names a provider the workspace owns or a platform-wide
 *   one, so a single-tenant install maps one IdP's groups in every workspace.
 *   It takes effect at each person's next sign-in (`RoleSyncService.apply`);
 * - a SCIM mapping (no provider) names a group the workspace's SCIM client
 *   pushed, by id. Provisioning already knows who is in the group, so the
 *   group's members are re-synced on the spot.
 *
 * A null provider is not covered by the table's unique index (NULLs are
 * distinct), so SCIM upserts read-then-write; a race leaves a duplicate row,
 * which role sync reads as the same group twice — harmless — and the next
 * upsert of that group replaces the first.
 */
@Injectable()
export class GroupMappingsService {
  private readonly sso: boolean;
  private readonly scim: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly roleSync: RoleSyncService,
    config: ConfigService<Env, true>,
  ) {
    this.sso = ssoEnabled(config);
    this.scim = scimEnabled(config);
  }

  async list(workspaceId: string): Promise<ListGroupMappingsResponse> {
    const kinds: Prisma.IdpGroupMappingWhereInput[] = [
      ...(this.sso ? [{ providerId: { not: null } }] : []),
      ...(this.scim ? [{ providerId: null }] : []),
    ];
    const [rows, providers, scimGroups] = await Promise.all([
      this.prisma.idpGroupMapping.findMany({
        where: { workspaceId, OR: kinds },
        include: { provider: true },
        orderBy: [{ externalGroup: 'asc' }, { id: 'asc' }],
      }),
      this.sso
        ? this.prisma.identityProvider.findMany({ where: this.mappable(workspaceId), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
        : Promise.resolve([]),
      this.scim
        ? this.prisma.scimGroup.findMany({
            where: { workspaceId },
            include: { _count: { select: { members: true } } },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
    ]);
    const groupName = new Map(scimGroups.map((g) => [g.id, g.displayName]));
    return {
      mappings: rows.map((r) => this.view(r, r.provider, groupName.get(r.externalGroup) ?? null)),
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        groupSyncMode: (GROUP_SYNC_MODES as readonly string[]).includes(p.groupSyncMode) ? (p.groupSyncMode as GroupSyncMode) : 'additive',
        groupsClaim: p.groupsClaim,
      })),
      scimGroups: scimGroups.map((g) => ({ id: g.id, displayName: g.displayName, memberCount: g._count.members })),
      enabled: { sso: this.sso, scim: this.scim },
    };
  }

  /** One mapping per (provider or SCIM, group): posting the same group again replaces its role. */
  async upsert(workspaceId: string, dto: UpsertGroupMappingDto, principal: Principal, retried = false): Promise<GroupMappingView> {
    const externalGroup = dto.externalGroup.trim();
    if (!externalGroup) throw new BadRequestException(t('error.sso.groupNameRequired'));

    let provider: IdentityProvider | null = null;
    let scimGroupName: string | null = null;
    if (dto.providerId) {
      if (!this.sso) throw new NotFoundException(t('error.sso.disabled'));
      provider = await this.prisma.identityProvider.findFirst({ where: { id: dto.providerId, ...this.mappable(workspaceId) } });
      if (!provider) throw new BadRequestException(t('error.sso.groupMappingProvider'));
    } else {
      if (!this.scim) throw new NotFoundException(t('error.scim.disabled'));
      const group = /^[0-9a-f-]{36}$/i.test(externalGroup)
        ? await this.prisma.scimGroup.findFirst({ where: { id: externalGroup, workspaceId } })
        : null;
      if (!group) throw new BadRequestException(t('error.scim.mappingGroup'));
      scimGroupName = group.displayName;
    }
    const providerId = provider?.id ?? null;

    const data = { role: dto.role, trustedOperator: dto.trustedOperator ?? false };
    const existing = await this.prisma.idpGroupMapping.findFirst({ where: { workspaceId, providerId, externalGroup } });
    let row: IdpGroupMapping;
    try {
      row = existing
        ? await this.prisma.idpGroupMapping.update({ where: { id: existing.id }, data })
        : await this.prisma.idpGroupMapping.create({ data: { workspaceId, providerId, externalGroup, ...data } });
    } catch (e) {
      // Two admins adding the same group at once: the loser replaces the winner's row.
      if (!retried && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return this.upsert(workspaceId, dto, principal, true);
      }
      throw e;
    }
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'sso.group_mapping_created',
      params: { providerId, externalGroup, ...(scimGroupName ? { scimGroup: scimGroupName } : {}), ...data, replaced: existing ? { role: existing.role, trustedOperator: existing.trustedOperator } : null },
      ok: true,
      target: row.id,
    });
    if (!providerId) await this.resyncScimGroup(workspaceId, externalGroup);
    return this.view(row, provider, scimGroupName);
  }

  async remove(workspaceId: string, mappingId: string, principal: Principal): Promise<void> {
    const row = await this.prisma.idpGroupMapping.findFirst({ where: { id: mappingId, workspaceId } });
    if (!row) throw new NotFoundException(t('error.sso.groupMappingNotFound'));
    // One commit (#656): the retry 404s, so a deleted mapping whose re-sync failed would leave its role in place.
    await this.prisma.withTransaction(
      async () => {
        await this.prisma.idpGroupMapping.delete({ where: { id: row.id } });
        this.prisma.onCommit(() =>
          this.audit.record({
            workspaceId,
            actor: principal.userId,
            action: 'sso.group_mapping_deleted',
            params: { providerId: row.providerId, externalGroup: row.externalGroup, role: row.role, trustedOperator: row.trustedOperator },
            ok: true,
            target: row.id,
          }),
        );
        if (!row.providerId && this.scim) await this.resyncScimGroup(workspaceId, row.externalGroup);
      },
      SCIM_TX,
    );
  }

  private async resyncScimGroup(workspaceId: string, groupId: string): Promise<void> {
    const members = await this.prisma.scimGroupMember.findMany({ where: { groupId, group: { workspaceId } }, select: { userId: true } });
    await this.roleSync.applyScim(workspaceId, members.map((m) => m.userId));
  }

  /** Providers a workspace's mapping may name: its own, and every platform-wide one. */
  private mappable(workspaceId: string): Prisma.IdentityProviderWhereInput {
    return { OR: [{ workspaceId }, { platformWide: true }] };
  }

  private view(r: IdpGroupMapping, provider: IdentityProvider | null, scimGroupName: string | null): GroupMappingView {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      providerId: r.providerId,
      providerName: provider?.name ?? null,
      externalGroup: r.externalGroup,
      scimGroupName,
      role: (WORKSPACE_ROLES as readonly string[]).includes(r.role) ? (r.role as WorkspaceRole) : 'viewer',
      trustedOperator: r.trustedOperator,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
