import { Injectable } from '@nestjs/common';
import type { IdentityProvider, IdpGroupMapping, WorkspaceMember } from '@prisma/client';
import { SCIM_DEFAULT_ROLES, WORKSPACE_ROLES, type MembershipSource, type ScimDefaultRole, type WorkspaceRole } from '@knowledge/contracts';
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

/** What a sync did to one workspace membership. */
export interface RoleSyncChange {
  workspaceId: string;
  kind: 'added' | 'updated' | 'removed' | 'blocked';
}

interface Target {
  role: WorkspaceRole;
  trustedOperator: boolean;
  source: Extract<MembershipSource, 'jit' | 'group' | 'scim'>;
  matched: string[];
}

type Snapshot = Pick<WorkspaceMember, 'role' | 'trustedOperator' | 'source'> | null;

/** Who is syncing: which rows it owns, and what its audit entries say about it. */
interface SyncContext {
  owned: readonly string[];
  authoritative: boolean;
  params: Record<string, unknown>;
}

const isRole = (r: string | null): r is WorkspaceRole => (WORKSPACE_ROLES as readonly string[]).includes(r ?? '');
const snapshot = (m: Snapshot) => (m ? { role: m.role, trustedOperator: m.trustedOperator, source: m.source } : null);

/** Rows a sign-in may change. `manual` is a person's, `scim` belongs to provisioning. */
const SIGN_IN_SOURCES: readonly string[] = ['jit', 'group'];
/**
 * Rows provisioning may change: its own, and the sign-in ones it takes over.
 * A workspace that provisions over SCIM has made the IdP's directory the
 * authority, and a deactivation has to reach a membership JIT created.
 */
const SCIM_SOURCES: readonly string[] = ['jit', 'group', 'scim'];

/** `workspace_settings.scim_default_role` as stored; null and anything unknown read as `viewer`. */
export function scimDefaultRoleOf(stored: string | null | undefined): ScimDefaultRole {
  return (SCIM_DEFAULT_ROLES as readonly string[]).includes(stored ?? '') ? (stored as ScimDefaultRole) : 'viewer';
}

/** The highest role among mapping hits, and the operator flag if any grants it. */
function fromHits(hits: IdpGroupMapping[], source: Target['source']): Target | null {
  const usable = hits.filter((m) => isRole(m.role));
  if (!usable.length) return null;
  return {
    role: usable.map((m) => m.role as WorkspaceRole).reduce((a, b) => (ROLE_ORDER[b] > ROLE_ORDER[a] ? b : a)),
    trustedOperator: usable.some((m) => m.trustedOperator),
    source,
    matched: [...new Set(usable.map((m) => m.externalGroup))],
  };
}

/**
 * IdP groups → workspace roles (#75 phases 3 and 5), run on every SSO sign-in
 * and on every SCIM change that can move a role.
 *
 * Sign-in: the provider's mappings decide, per workspace they cover: the
 * highest mapped role wins, and any matching mapping with `trustedOperator`
 * grants it. With no mapping hit, the provider's own workspace falls back to
 * the JIT default role; any other workspace gets nothing. `additive` only ever
 * raises a role or grants the operator flag; `authoritative` makes the row
 * exactly what the groups say, and removes it when they say nothing.
 *
 * SCIM: the workspace's provider-less mappings over the SCIM groups the client
 * put the person in, else the workspace's SCIM default role; a deactivated or
 * deleted person gets nothing. Always authoritative — the directory is the
 * whole truth about who belongs.
 *
 * Each writes only rows it owns or creates. A `manual` row is never changed —
 * the guard is in the statement, so an admin taking a row over mid-sync wins —
 * and sign-in leaves a `scim` row to provisioning. Demoting or removing the
 * last admin is refused by the shared single-statement guard, audited as
 * `role_sync.blocked_last_admin`, and never thrown into the caller.
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
    const ctx: SyncContext = {
      owned: SIGN_IN_SOURCES,
      authoritative: provider.groupSyncMode === 'authoritative' && groupsKnown,
      params: { providerId: provider.id, mode: provider.groupSyncMode },
    };

    const changes: RoleSyncChange[] = [];
    for (const workspaceId of workspaceIds) {
      const current = members.find((m) => m.workspaceId === workspaceId) ?? null;
      const target = this.signInTarget(provider, workspaceId, usable, groups);
      const change = await this.reconcile(ctx, userId, workspaceId, current, target);
      if (change) changes.push(change);
      else if (!groupsKnown && workspaceId === provider.workspaceId) {
        // Nothing changed, but an admin should see why an authoritative
        // provider took nothing away.
        void this.record(ctx, userId, workspaceId, current, current, target, { groupsUnknown: true });
      }
    }
    return changes;
  }

  /**
   * Re-derive the SCIM-managed membership of these people in one workspace
   * from what provisioning knows now: their `scim_users` row, their SCIM
   * groups, the workspace's SCIM mappings and default role. Reads in bulk, so
   * a mapping change can re-sync a whole group in one request; writes only
   * where something moves.
   */
  async applyScim(workspaceId: string, userIds: string[]): Promise<RoleSyncChange[]> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return [];
    const [records, memberships, mappings, members, settings] = await Promise.all([
      this.prisma.scimUser.findMany({ where: { workspaceId, userId: { in: ids } } }),
      this.prisma.scimGroupMember.findMany({ where: { userId: { in: ids }, group: { workspaceId } } }),
      this.prisma.idpGroupMapping.findMany({ where: { workspaceId, providerId: null } }),
      this.prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: ids } } }),
      this.prisma.workspaceSettings.findUnique({ where: { workspaceId } }),
    ]);
    const defaultRole = scimDefaultRoleOf(settings?.scimDefaultRole);
    const ctx: SyncContext = { owned: SCIM_SOURCES, authoritative: true, params: { via: 'scim', defaultRole } };

    const changes: RoleSyncChange[] = [];
    for (const userId of ids) {
      const record = records.find((r) => r.userId === userId);
      let target: Target | null = null;
      if (record?.active) {
        const groups = new Set(memberships.filter((m) => m.userId === userId).map((m) => m.groupId));
        target =
          fromHits(mappings.filter((m) => groups.has(m.externalGroup)), 'scim') ??
          (defaultRole === 'none' ? null : { role: defaultRole, trustedOperator: false, source: 'scim', matched: [] });
      }
      const current = members.find((m) => m.userId === userId) ?? null;
      const change = await this.reconcile(ctx, userId, workspaceId, current, target);
      if (change) changes.push(change);
    }
    return changes;
  }

  /** What the asserted groups say this person should be in one workspace, or null for "nothing". */
  private signInTarget(provider: IdentityProvider, workspaceId: string, mappings: IdpGroupMapping[], groups: string[]): Target | null {
    const asserted = new Set(groups);
    const hit = fromHits(
      mappings.filter((m) => m.workspaceId === workspaceId && asserted.has(m.externalGroup)),
      'group',
    );
    if (hit) return hit;
    if (workspaceId === provider.workspaceId && provider.jitEnabled && isRole(provider.defaultRole)) {
      return { role: provider.defaultRole, trustedOperator: false, source: 'jit', matched: [] };
    }
    return null;
  }

  private async reconcile(
    ctx: SyncContext,
    userId: string,
    workspaceId: string,
    current: WorkspaceMember | null,
    target: Target | null,
  ): Promise<RoleSyncChange | null> {
    if (current && !ctx.owned.includes(current.source)) return null;

    if (!current) {
      if (!target) return null;
      const { count } = await this.prisma.workspaceMember.createMany({
        data: [{ workspaceId, userId, role: target.role, trustedOperator: target.trustedOperator, source: target.source }],
        // A row that appeared since the read — manual or not — is left as it is.
        skipDuplicates: true,
      });
      if (!count) return null;
      void this.record(ctx, userId, workspaceId, null, target, target);
      return { workspaceId, kind: 'added' };
    }

    if (!target) {
      if (!ctx.authoritative) return null;
      if (await removeMemberGuarded(this.prisma, workspaceId, userId, { sources: ctx.owned })) {
        void this.record(ctx, userId, workspaceId, current, null, null);
        return { workspaceId, kind: 'removed' };
      }
      return this.blocked(ctx, userId, workspaceId, current, null);
    }

    const heldRank = isRole(current.role) ? ROLE_ORDER[current.role] : -Infinity;
    const role = ctx.authoritative || ROLE_ORDER[target.role] > heldRank ? target.role : (current.role as WorkspaceRole);
    const trustedOperator = ctx.authoritative ? target.trustedOperator : current.trustedOperator || target.trustedOperator;
    // A row keeps its label while additive sync keeps a higher role it already
    // held; it takes the target's once the target decides the role.
    const source = role === target.role ? target.source : current.source;
    const roleChanges = role !== current.role;
    if (!roleChanges && trustedOperator === current.trustedOperator && source === current.source) return null;

    if (roleChanges && !(await setRoleGuarded(this.prisma, workspaceId, userId, role, { sources: ctx.owned }))) {
      return this.blocked(ctx, userId, workspaceId, current, { role, trustedOperator });
    }
    await this.prisma.workspaceMember.updateMany({
      where: { workspaceId, userId, source: { in: [...ctx.owned] } },
      data: { trustedOperator, source },
    });
    const after = { role, trustedOperator, source };
    void this.record(ctx, userId, workspaceId, current, after, target);
    return { workspaceId, kind: 'updated' };
  }

  private blocked(
    ctx: SyncContext,
    userId: string,
    workspaceId: string,
    current: WorkspaceMember,
    wanted: { role: string; trustedOperator: boolean } | null,
  ): RoleSyncChange {
    void this.audit.record({
      workspaceId,
      actor: 'role-sync',
      action: 'role_sync.blocked_last_admin',
      params: { ...ctx.params, before: snapshot(current), wanted },
      ok: false,
      error: 'last-admin',
      target: userId,
    });
    return { workspaceId, kind: 'blocked' };
  }

  private record(
    ctx: SyncContext,
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
        ...ctx.params,
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
