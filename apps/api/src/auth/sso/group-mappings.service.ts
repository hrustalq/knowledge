import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type IdentityProvider, type IdpGroupMapping } from '@prisma/client';
import {
  GROUP_SYNC_MODES,
  WORKSPACE_ROLES,
  type GroupMappingView,
  type GroupSyncMode,
  type ListGroupMappingsResponse,
  type WorkspaceRole,
} from '@knowledge/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { t } from '../../i18n/t.js';
import { AuditService } from '../audit.service.js';
import type { Principal } from '../principal.js';
import type { UpsertGroupMappingDto } from './identity-providers.dto.js';

/**
 * A workspace's IdP group → role mappings (#75 phase 3), Settings → Security
 * → Group mapping. A mapping names a provider the workspace owns or a
 * platform-wide one, so a single-tenant install maps one IdP's groups in every
 * workspace. Mappings take effect at each person's next sign-in
 * (`RoleSyncService`); nothing here rewrites memberships.
 */
@Injectable()
export class GroupMappingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(workspaceId: string): Promise<ListGroupMappingsResponse> {
    const [rows, providers] = await Promise.all([
      this.prisma.idpGroupMapping.findMany({
        where: { workspaceId, providerId: { not: null } },
        include: { provider: true },
        orderBy: [{ externalGroup: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.identityProvider.findMany({
        where: this.mappable(workspaceId),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return {
      mappings: rows.map((r) => this.view(r, r.provider)),
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        groupSyncMode: (GROUP_SYNC_MODES as readonly string[]).includes(p.groupSyncMode) ? (p.groupSyncMode as GroupSyncMode) : 'additive',
        groupsClaim: p.groupsClaim,
      })),
    };
  }

  /** One mapping per (provider, group): posting the same group again replaces its role. */
  async upsert(workspaceId: string, dto: UpsertGroupMappingDto, principal: Principal, retried = false): Promise<GroupMappingView> {
    const externalGroup = dto.externalGroup.trim();
    if (!externalGroup) throw new BadRequestException(t('error.sso.groupNameRequired'));
    const provider = await this.prisma.identityProvider.findFirst({ where: { id: dto.providerId, ...this.mappable(workspaceId) } });
    if (!provider) throw new BadRequestException(t('error.sso.groupMappingProvider'));

    const data = { role: dto.role, trustedOperator: dto.trustedOperator ?? false };
    const existing = await this.prisma.idpGroupMapping.findFirst({ where: { workspaceId, providerId: provider.id, externalGroup } });
    let row: IdpGroupMapping;
    try {
      row = existing
        ? await this.prisma.idpGroupMapping.update({ where: { id: existing.id }, data })
        : await this.prisma.idpGroupMapping.create({ data: { workspaceId, providerId: provider.id, externalGroup, ...data } });
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
      params: { providerId: provider.id, externalGroup, ...data, replaced: existing ? { role: existing.role, trustedOperator: existing.trustedOperator } : null },
      ok: true,
      target: row.id,
    });
    return this.view(row, provider);
  }

  async remove(workspaceId: string, mappingId: string, principal: Principal): Promise<void> {
    const row = await this.prisma.idpGroupMapping.findFirst({ where: { id: mappingId, workspaceId } });
    if (!row) throw new NotFoundException(t('error.sso.groupMappingNotFound'));
    await this.prisma.idpGroupMapping.delete({ where: { id: row.id } });
    void this.audit.record({
      workspaceId,
      actor: principal.userId,
      action: 'sso.group_mapping_deleted',
      params: { providerId: row.providerId, externalGroup: row.externalGroup, role: row.role, trustedOperator: row.trustedOperator },
      ok: true,
      target: row.id,
    });
  }

  /** Providers a workspace's mapping may name: its own, and every platform-wide one. */
  private mappable(workspaceId: string): Prisma.IdentityProviderWhereInput {
    return { OR: [{ workspaceId }, { platformWide: true }] };
  }

  private view(r: IdpGroupMapping, provider: IdentityProvider | null): GroupMappingView {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      providerId: r.providerId ?? '',
      providerName: provider?.name ?? null,
      externalGroup: r.externalGroup,
      role: (WORKSPACE_ROLES as readonly string[]).includes(r.role) ? (r.role as WorkspaceRole) : 'viewer',
      trustedOperator: r.trustedOperator,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
