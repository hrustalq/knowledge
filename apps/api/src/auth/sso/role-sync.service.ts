import { Injectable } from '@nestjs/common';
import type { IdentityProvider, IdpGroupMapping, WorkspaceMember } from '@prisma/client';
import { WORKSPACE_ROLES, type MembershipSource, type WorkspaceRole } from '@knowledge/contracts';
import { PrismaService } from '../../prisma/prisma.service.js';
import { removeMemberGuarded, setRoleGuarded } from '../../workspaces/membership-guards.js';
import { AuditService } from '../audit.service.js';
import { ROLE_ORDER } from '../principal.js';

export interface RoleSyncInput {
  provider: IdentityProvider;
  userId: string;
  /** The groups the IdP asserted at this sign-in. */
  groups: string[];
  /**
   * False when the IdP could not say (an Entra groups overage): absence of a
   * group is then no evidence, and nothing is taken away.
   */
  groupsKnown: boolean;
}

/** What a sign-in did to one workspace membership. */
export interface RoleSyncChange {
  workspaceId: string;
  kind: 'added' | 'updated' | 'removed' | 'blocked';
}

interface Target {
  role: WorkspaceRole;
  trustedOperator: boolean;
  source: Extract<MembershipSource, 'jit' | 'group'>;
  matched: string[];
}

type Snapshot = Pick<WorkspaceMember, 'role' | 'trustedOperator' | 'source'> | null;

const isRole = (r: string | null): r is WorkspaceRole => (WORKSPACE_ROLES as readonly string[]).includes(r ?? '');
const snapshot = (m: Snapshot) => (m ? { role: m.role, trustedOperator: m.trustedOperator, source: m.source } : null);

/** Rows a sign-in may change. `manual` is a person's, `scim` belongs to provisioning. */
const SYNCED_SOURCES: readonly string[] = ['jit', 'group'];

/**
 * IdP groups → workspace roles (#75 phase 3), run on every SSO sign-in.
 *
 * The provider's mappings decide, per workspace they cover: the highest mapped
 * role wins, and any matching mapping with `trustedOperator` grants it. With
 * no mapping hit, the provider's own workspace falls back to the JIT default
 * role; any other workspace gets nothing.
 *
 * It writes only rows it owns (`jit`, `group`) or creates. A `manual` row is
 * never changed — the guard is in the statement, so an admin taking a row over
 * mid-sign-in wins — and a `scim` row is left to provisioning.
 *
 * `additive` only ever raises a role or grants the operator flag;
 * `authoritative` makes the row exactly what the groups say, and removes it
 * when they say nothing. Demoting or removing the last admin is refused by the
 * shared single-statement guard, audited as `role_sync.blocked_last_admin`,
 * and never thrown into the sign-in.
 */
@Injectable()
export class RoleSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async apply(input: RoleSyncInput): Promise<RoleSyncChange[]> {
    const { provider, userId, groups, groupsKnown } = input;
    const mappings = await this.prisma.idpGroupMapping.findMany({ where: { providerId: provider.id } });
    // Another workspace's mapping of this provider counts only while the
    // provider is platform-wide; switching that off makes them inert.
    const usable = mappings.filter((m) => m.workspaceId === provider.workspaceId || provider.platformWide);
    const workspaceIds = [...new Set([provider.workspaceId, ...usable.map((m) => m.workspaceId)])];
    const members = await this.prisma.workspaceMember.findMany({ where: { userId, workspaceId: { in: workspaceIds } } });
    const authoritative = provider.groupSyncMode === 'authoritative' && groupsKnown;

    const changes: RoleSyncChange[] = [];
    for (const workspaceId of workspaceIds) {
      const current = members.find((m) => m.workspaceId === workspaceId) ?? null;
      const target = this.targetFor(provider, workspaceId, usable, groups);
      const change = await this.reconcile(provider, userId, workspaceId, current, target, authoritative);
      if (change) changes.push(change);
      else if (!groupsKnown && workspaceId === provider.workspaceId) {
        // Nothing changed, but an admin should see why an authoritative
        // provider took nothing away.
        void this.record(provider, userId, workspaceId, current, current, target, { groupsUnknown: true });
      }
    }
    return changes;
  }

  /** What the groups say this person should be in one workspace, or null for "nothing". */
  private targetFor(provider: IdentityProvider, workspaceId: string, mappings: IdpGroupMapping[], groups: string[]): Target | null {
    const asserted = new Set(groups);
    const hits = mappings.filter((m) => m.workspaceId === workspaceId && asserted.has(m.externalGroup) && isRole(m.role));
    if (hits.length) {
      const role = hits.map((m) => m.role as WorkspaceRole).reduce((a, b) => (ROLE_ORDER[b] > ROLE_ORDER[a] ? b : a));
      return {
        role,
        trustedOperator: hits.some((m) => m.trustedOperator),
        source: 'group',
        matched: [...new Set(hits.map((m) => m.externalGroup))],
      };
    }
    if (workspaceId === provider.workspaceId && provider.jitEnabled && isRole(provider.defaultRole)) {
      return { role: provider.defaultRole, trustedOperator: false, source: 'jit', matched: [] };
    }
    return null;
  }

  private async reconcile(
    provider: IdentityProvider,
    userId: string,
    workspaceId: string,
    current: WorkspaceMember | null,
    target: Target | null,
    authoritative: boolean,
  ): Promise<RoleSyncChange | null> {
    if (current && !SYNCED_SOURCES.includes(current.source)) return null;

    if (!current) {
      if (!target) return null;
      const { count } = await this.prisma.workspaceMember.createMany({
        data: [{ workspaceId, userId, role: target.role, trustedOperator: target.trustedOperator, source: target.source }],
        // A row that appeared since the read — manual or not — is left as it is.
        skipDuplicates: true,
      });
      if (!count) return null;
      void this.record(provider, userId, workspaceId, null, target, target);
      return { workspaceId, kind: 'added' };
    }

    if (!target) {
      if (!authoritative) return null;
      if (await removeMemberGuarded(this.prisma, workspaceId, userId, { managedOnly: true })) {
        void this.record(provider, userId, workspaceId, current, null, null);
        return { workspaceId, kind: 'removed' };
      }
      return this.blocked(provider, userId, workspaceId, current, null);
    }

    const heldRank = isRole(current.role) ? ROLE_ORDER[current.role] : -Infinity;
    const role = authoritative || ROLE_ORDER[target.role] > heldRank ? target.role : (current.role as WorkspaceRole);
    const trustedOperator = authoritative ? target.trustedOperator : current.trustedOperator || target.trustedOperator;
    const roleChanges = role !== current.role;
    if (!roleChanges && trustedOperator === current.trustedOperator) return null;

    if (roleChanges && !(await setRoleGuarded(this.prisma, workspaceId, userId, role, { managedOnly: true }))) {
      return this.blocked(provider, userId, workspaceId, current, { role, trustedOperator });
    }
    await this.prisma.workspaceMember.updateMany({
      where: { workspaceId, userId, source: { in: [...SYNCED_SOURCES] } },
      data: { trustedOperator, source: target.source },
    });
    const after = { role, trustedOperator, source: target.source };
    void this.record(provider, userId, workspaceId, current, after, target);
    return { workspaceId, kind: 'updated' };
  }

  private blocked(
    provider: IdentityProvider,
    userId: string,
    workspaceId: string,
    current: WorkspaceMember,
    wanted: { role: string; trustedOperator: boolean } | null,
  ): RoleSyncChange {
    void this.audit.record({
      workspaceId,
      actor: 'role-sync',
      action: 'role_sync.blocked_last_admin',
      params: { providerId: provider.id, before: snapshot(current), wanted },
      ok: false,
      error: 'last-admin',
      target: userId,
    });
    return { workspaceId, kind: 'blocked' };
  }

  private record(
    provider: IdentityProvider,
    userId: string,
    workspaceId: string,
    before: Snapshot,
    after: Snapshot,
    target: Target | null,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.audit.record({
      workspaceId,
      actor: 'role-sync',
      action: 'role_sync.applied',
      params: {
        providerId: provider.id,
        mode: provider.groupSyncMode,
        before: snapshot(before),
        after: snapshot(after),
        matchedGroups: target?.matched ?? [],
        ...extra,
      },
      ok: true,
      target: userId,
    });
  }
}
