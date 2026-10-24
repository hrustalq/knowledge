import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector, ConnectorLink, UserGroup } from '@prisma/client';
import {
  connectorKindInfo,
  type ConnectorAclMode,
  type ConnectorAclResponse,
  type ExternalIdentityMapping,
  type UpdateConnectorAclRequest,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { AclEventsService } from '../permissions/acl-events.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_PRINCIPAL_NAME } from './adapters/acl-layers.js';
import type {
  ConnectorAdapter,
  ConnectorContext,
  ExternalAcl,
  ExternalGroupMember,
  ExternalPrincipal,
  ExternalRef,
} from './adapters/connector.types.js';
import { isUniqueViolation, releaseMirroredAccess } from './connector-acl-release.js';
import { aclPlanHash, planAcl, type AclPlan, type StoredAcl } from './connector-acl.js';
import { ConnectorsService } from './connectors.service.js';

/** How long a person or group just written is trusted, so a 1 000-page pull does not rewrite the same 20 people 1 000 times. */
const RECENT_MS = 10 * 60_000;

/** Kinds whose people can be matched through a linked GitHub account. */
const GITHUB_KINDS = new Set(['markdown-git', 'codebase']);

/** The link fields the mirror reads and writes. */
type MirrorLink = Pick<ConnectorLink, 'id' | 'documentId' | 'aclHash' | 'aclRestricted'>;

export interface MirrorOutcome {
  changed: boolean;
  /** What the page's item should say about it, already in the run's language. */
  warnings: string[];
}

/**
 * Connector ACL mirroring (#76, phase 6).
 *
 * The worker generates and the API publishes, except where a page is written:
 * a pull already writes pages from the worker (feature 19's exception), and a
 * page must be restricted in the same transaction that creates it, or a
 * private upstream page is readable by the whole workspace for one tick. So
 * the mirror runs where the content does — staging's `apply`, the ACL-only
 * refresh — and writes only `origin = 'connector'` grants, which no person
 * owns and the API never edits.
 *
 * From there it is an ordinary restriction: `restricted_by`, the re-stamp
 * sweeper, search, the graph, the assistant and MCP all read it unchanged.
 */
@Injectable()
export class ConnectorAclService {
  private readonly logger = new Logger(ConnectorAclService.name);
  private readonly recent = new Map<string, number>();
  private readonly announcing = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly connectors: ConnectorsService,
    private readonly permissions: PermissionService,
    private readonly aclEvents: AclEventsService,
  ) {}

  // --- capture: what upstream says, read while staging ---

  /**
   * Read one item's upstream ACL and remember the people and groups it names.
   * Null when the connector does not mirror; never throws for an unreadable
   * ACL — that is recorded, and fails closed when applied.
   */
  async capture(row: Connector, adapter: ConnectorAdapter, ctx: ConnectorContext, ref: ExternalRef): Promise<StoredAcl | null> {
    if (row.aclMode === 'off') return null;
    if (!adapter.permissions) return { kind: 'audience' };
    let acl: ExternalAcl;
    try {
      acl = await adapter.permissions(ctx, ref);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      ctx.debug('acl: unreadable', { id: ref.externalId, error: (err as Error).message });
      return { kind: 'error', message: (err as Error).message.slice(0, 500) };
    }
    await this.upsertIdentities(row, acl.principals.filter((p) => p.type === 'user'));
    for (const group of acl.principals.filter((p) => p.type === 'group')) {
      await this.ensureGroup(row, adapter, ctx, group, false);
    }
    return { kind: 'acl', acl };
  }

  /** The warnings applying `stored` would raise, for the item a reviewer reads before approving it. */
  async preview(row: Connector, stored: StoredAcl): Promise<string[]> {
    if (row.aclMode === 'off') return [];
    return this.warningsFor(stored, await this.plan(row, stored));
  }

  // --- apply: write it onto one page ---

  /**
   * Make one page's connector grants and switch say what `stored` says.
   *
   * Joins the caller's transaction when there is one — staging creates the
   * page, its link and its restriction in one. Idempotent by hash: a page
   * whose planned restriction is what was last written is not touched.
   *
   * Only this connector's rows are rewritten. Manual grants are never read
   * for writing, and a switch a person turned on is never turned off: the
   * connector lifts only a restriction it placed (`acl_restricted`), and only
   * while no manual grant is left on the page.
   */
  async applyToPage(row: Connector, link: MirrorLink, stored: StoredAcl | null): Promise<MirrorOutcome> {
    if (row.aclMode === 'off' || !stored) return { changed: false, warnings: [] };
    // A page already mirrored keeps what it had through a failed read: one
    // transient upstream error must neither open a page nor lock it.
    if (stored.kind === 'error' && link.aclHash !== null) {
      return { changed: false, warnings: [t('connector.acl.readFailedKept', { error: stored.message })] };
    }

    const plan = await this.plan(row, stored);
    const warnings = this.warningsFor(stored, plan);
    const hash = aclPlanHash(plan);
    // Same plan as last time is a no-op — unless the switch was turned off by
    // hand since. A mirrored restriction is the source's to lift, not a
    // manager's: it is put back on the next sync.
    if (hash === link.aclHash) {
      const doc = plan.restricted
        ? await this.prisma.document.findUnique({ where: { id: link.documentId }, select: { restricted: true } })
        : null;
      if (!plan.restricted || !doc || doc.restricted) return { changed: false, warnings };
    }

    const changed = await this.prisma.withTransaction(async () => {
      const doc = await this.prisma.document.findUnique({
        where: { id: link.documentId },
        select: { workspaceId: true, restricted: true },
      });
      if (!doc) return false;

      await this.prisma.accessGrant.deleteMany({
        where: { resourceType: 'document', resourceId: link.documentId, origin: 'connector', connectorId: row.id },
      });
      if (plan.grants.length > 0) {
        await this.prisma.accessGrant.createMany({
          data: plan.grants.map((g) => ({
            workspaceId: doc.workspaceId,
            resourceType: 'document',
            resourceId: link.documentId,
            subjectType: g.subjectType,
            subjectId: g.subjectId,
            level: g.level,
            origin: 'connector',
            connectorId: row.id,
          })),
          skipDuplicates: true,
        });
      }

      let restricted = doc.restricted;
      let ours = link.aclRestricted;
      if (plan.restricted && !doc.restricted) {
        restricted = true;
        ours = true;
      } else if (!plan.restricted && doc.restricted && link.aclRestricted) {
        const manual = await this.prisma.accessGrant.count({
          where: { resourceType: 'document', resourceId: link.documentId, origin: 'manual' },
        });
        if (manual === 0) restricted = false;
        ours = false;
      }
      if (restricted !== doc.restricted) {
        await this.prisma.document.update({ where: { id: link.documentId }, data: { restricted } });
        await this.permissions.recomputeRestrictedBy({ documentId: link.documentId });
      }
      await this.prisma.connectorLink.update({ where: { id: link.id }, data: { aclHash: hash, aclRestricted: ours } });
      return true;
    });

    if (changed) this.prisma.onCommit(async () => this.announce(row.workspaceId));
    return { changed, warnings };
  }

  // --- refresh: the ACL-only pass, no content ---

  /**
   * Re-read every linked page's ACL and re-apply it (#76). Permission calls
   * only, so a restriction lifted upstream is lifted here without a content
   * fetch, and someone who signed up or was mapped since is admitted.
   *
   * `acl_synced_at` is stamped first: it is the claim, and it keeps a
   * connector whose upstream is down from being retried every tick.
   */
  async refresh(row: Connector, signal?: AbortSignal): Promise<{ pages: number; changed: number; failed: number }> {
    const totals = { pages: 0, changed: 0, failed: 0 };
    if (row.aclMode === 'off') return totals;
    await this.prisma.connector.update({ where: { id: row.id }, data: { aclSyncedAt: new Date() } });

    const adapter = this.connectors.adapterFor(row);
    const ctx = await this.connectors.contextFor(row, async () => undefined, signal);

    // People first (someone may have signed up or been mapped since), then
    // groups: a membership change is the cheapest way access moves.
    await this.resolveIdentities(row);
    let membership = false;
    if (adapter.groupMembers) {
      const groups = await this.prisma.userGroup.findMany({ where: { connectorId: row.id } });
      for (const group of groups) {
        if (signal?.aborted) break;
        membership = (await this.syncMembers(row, adapter, ctx, group, toPrincipal(group))) || membership;
      }
    }

    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId: row.id },
      take: this.config.get('CONNECTOR_SYNC_MAX_ITEMS', { infer: true }),
      orderBy: { createdAt: 'asc' },
    });
    for (const link of links) {
      if (signal?.aborted) break;
      totals.pages += 1;
      try {
        const stored = await this.capture(row, adapter, ctx, {
          externalId: link.externalId,
          title: link.externalTitle ?? '',
          ...(link.externalUrl ? { url: link.externalUrl } : {}),
          ...(link.externalVersion ? { version: link.externalVersion } : {}),
        });
        if (stored?.kind === 'error') totals.failed += 1;
        if ((await this.applyToPage(row, link, stored)).changed) totals.changed += 1;
      } catch (err) {
        totals.failed += 1;
        this.logger.warn({ msg: 'Connector ACL refresh failed for a page', connectorId: row.id, linkId: link.id, err });
      }
    }
    if (membership) this.announce(row.workspaceId);
    return totals;
  }

  // --- the connector page (API) ---

  async describe(connectorId: string): Promise<ConnectorAclResponse> {
    const row = await this.connectors.require(connectorId);
    const [identities, restrictedPages, groupCount] = await Promise.all([
      this.prisma.externalIdentity.findMany({
        where: { connectorId },
        // Unmapped first: they are the rows somebody came here to fix.
        orderBy: [{ userId: { sort: 'asc', nulls: 'first' } }, { displayName: 'asc' }],
        take: 500,
      }),
      this.prisma.connectorLink.count({ where: { connectorId, aclRestricted: true } }),
      this.prisma.userGroup.count({ where: { connectorId } }),
    ]);
    const userIds = [...new Set(identities.flatMap((i) => (i.userId ? [i.userId] : [])))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })
      : [];
    const nameOf = new Map(users.map((u) => [u.id, u.displayName]));
    return {
      connectorId,
      mode: row.aclMode as ConnectorAclMode,
      syncIntervalMinutes: row.aclSyncIntervalMinutes,
      defaultSyncIntervalMinutes: this.config.get('CONNECTOR_ACL_SYNC_DEFAULT_MIN', { infer: true }),
      audienceGroupId: row.aclAudienceGroupId,
      perItem: connectorKindInfo(row.kind)?.capabilities.acl === true,
      syncedAt: row.aclSyncedAt?.toISOString() ?? null,
      restrictedPages,
      groupCount,
      identities: identities.map((i) => ({
        id: i.id,
        externalId: i.externalId,
        displayName: i.displayName,
        email: i.email,
        userId: i.userId,
        userDisplayName: i.userId ? (nameOf.get(i.userId) ?? null) : null,
        mappedBy: (i.mappedBy as ExternalIdentityMapping | null) ?? null,
        lastSeenAt: i.lastSeenAt.toISOString(),
      })),
    };
  }

  /**
   * Change how a connector mirrors. Switching it off hands what it mirrored
   * over to people (`releaseMirroredAccess`) rather than opening anything.
   * Returns whether a refresh should run now.
   */
  async updateSettings(connectorId: string, dto: UpdateConnectorAclRequest): Promise<boolean> {
    const row = await this.connectors.require(connectorId);
    const audienceGroupId = dto.audienceGroupId === undefined ? row.aclAudienceGroupId : dto.audienceGroupId;
    if (dto.mode !== 'off') {
      const perItem = connectorKindInfo(row.kind)?.capabilities.acl === true;
      if (!perItem && !audienceGroupId) {
        throw new BadRequestException(t('error.connector.aclAudienceRequired', { kind: connectorKindInfo(row.kind)?.label ?? row.kind }));
      }
      if (GITHUB_KINDS.has(row.kind)) {
        const repoUrl = String((row.config as Record<string, unknown> | null)?.repoUrl ?? '');
        const host = safeHostname(repoUrl);
        if (host !== 'github.com') throw new BadRequestException(t('error.connector.aclUnsupportedHost', { host: host ?? repoUrl }));
      }
    }
    if (audienceGroupId) {
      const group = await this.prisma.userGroup.findFirst({ where: { id: audienceGroupId, workspaceId: row.workspaceId } });
      if (!group) throw new BadRequestException(t('error.connector.aclAudienceGroup'));
    }

    if (dto.mode === 'off' && row.aclMode !== 'off') await releaseMirroredAccess(this.prisma, connectorId);
    const turnedOn = dto.mode !== 'off' && (row.aclMode === 'off' || audienceGroupId !== row.aclAudienceGroupId);
    await this.prisma.connector.update({
      where: { id: connectorId },
      data: {
        aclMode: dto.mode,
        aclAudienceGroupId: audienceGroupId ?? null,
        ...(dto.syncIntervalMinutes !== undefined ? { aclSyncIntervalMinutes: dto.syncIntervalMinutes } : {}),
        // Due at once, so the next tick (or the job the caller queues) mirrors it.
        ...(turnedOn ? { aclSyncedAt: null } : {}),
      },
    });
    return dto.mode !== 'off' && (turnedOn || dto.mode !== row.aclMode);
  }

  /**
   * Map an upstream identity to a member by hand, or clear a manual mapping so
   * it re-resolves. Takes effect on the next refresh, which the caller queues:
   * the pages and groups that name this person are rewritten there.
   */
  async mapIdentity(connectorId: string, identityId: string, userId: string | null): Promise<void> {
    const row = await this.connectors.require(connectorId);
    const identity = await this.prisma.externalIdentity.findFirst({ where: { id: identityId, connectorId } });
    if (!identity) throw new NotFoundException(t('error.connector.identityNotFound', { id: identityId }));
    if (userId) {
      const member = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: row.workspaceId, userId } },
        select: { userId: true },
      });
      if (!member) throw new BadRequestException(t('error.connector.identityNotMember'));
      await this.prisma.externalIdentity.update({ where: { id: identityId }, data: { userId, mappedBy: 'manual' } });
    } else {
      await this.prisma.externalIdentity.update({ where: { id: identityId }, data: { userId: null, mappedBy: null } });
      await this.resolveIdentities(row, [identity.externalId]);
    }
  }

  // --- people and groups ---

  /**
   * Who each upstream id is here, for every identity a person has not mapped
   * by hand: a linked GitHub account, then a verified email. Only workspace
   * members resolve — a grant to anyone else would admit nobody and name a
   * stranger on the connector page.
   */
  async resolveIdentities(row: Connector, externalIds?: string[]): Promise<number> {
    const rows = await this.prisma.externalIdentity.findMany({
      where: {
        connectorId: row.id,
        ...(externalIds ? { externalId: { in: externalIds } } : {}),
        OR: [{ mappedBy: null }, { mappedBy: { not: 'manual' } }],
      },
    });
    if (rows.length === 0) return 0;

    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: row.workspaceId },
      select: { userId: true, user: { select: { email: true, emailVerifiedAt: true } } },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    const byEmail = new Map(
      members.filter((m) => m.user.emailVerifiedAt !== null).map((m) => [m.user.email.toLowerCase(), m.userId]),
    );
    const byProvider = new Map<string, string>();
    if (GITHUB_KINDS.has(row.kind)) {
      const numeric = rows.map((r) => r.externalId).filter((id) => /^\d{1,19}$/.test(id));
      if (numeric.length > 0) {
        const tokens = await this.prisma.githubUserToken.findMany({
          where: { githubUserId: { in: numeric.map((id) => BigInt(id)) } },
          select: { userId: true, githubUserId: true },
        });
        for (const tok of tokens) if (memberIds.has(tok.userId)) byProvider.set(String(tok.githubUserId), tok.userId);
      }
    }

    let changed = 0;
    for (const r of rows) {
      const provider = byProvider.get(r.externalId);
      const email = r.email ? byEmail.get(r.email.toLowerCase()) : undefined;
      const next: { userId: string | null; mappedBy: ExternalIdentityMapping | null } = provider
        ? { userId: provider, mappedBy: 'provider' }
        : email
          ? { userId: email, mappedBy: 'email' }
          : { userId: null, mappedBy: null };
      if (next.userId === r.userId && next.mappedBy === r.mappedBy) continue;
      await this.prisma.externalIdentity.update({ where: { id: r.id }, data: next });
      changed += 1;
    }
    return changed;
  }

  /**
   * One upstream person, recorded and resolved now: the member they are, or
   * null while unmapped. Who resolved a harvested item (#382) is asked this
   * way — the same table and resolver as access mirroring, so a person has one
   * answer however a connector met them.
   */
  async userFor(row: Connector, person: ExternalGroupMember): Promise<string | null> {
    await this.upsertIdentities(row, [person]);
    const found = await this.prisma.externalIdentity.findUnique({
      where: { connectorId_externalId: { connectorId: row.id, externalId: person.externalId } },
      select: { userId: true },
    });
    return found?.userId ?? null;
  }

  private async upsertIdentities(row: Connector, people: ExternalGroupMember[]): Promise<void> {
    const now = Date.now();
    const fresh = people.filter((p) => now - (this.recent.get(`${row.id}:u:${p.externalId}`) ?? 0) > RECENT_MS);
    if (fresh.length === 0) return;
    for (const p of fresh) {
      const displayName = p.name ? p.name.slice(0, MAX_PRINCIPAL_NAME) : null;
      const email = p.email ? p.email.slice(0, MAX_PRINCIPAL_NAME).toLowerCase() : null;
      await this.prisma.externalIdentity.upsert({
        where: { connectorId_externalId: { connectorId: row.id, externalId: p.externalId } },
        create: { workspaceId: row.workspaceId, connectorId: row.id, externalId: p.externalId, displayName, email },
        update: {
          lastSeenAt: new Date(),
          ...(displayName ? { displayName } : {}),
          ...(email ? { email } : {}),
        },
      });
      this.recent.set(`${row.id}:u:${p.externalId}`, now);
    }
    if (this.recent.size > 50_000) this.recent.clear();
    await this.resolveIdentities(row, fresh.map((p) => p.externalId));
  }

  /**
   * The mirrored group for an upstream group, created on first sight. Its
   * members are read when it is created and on every refresh, not per page.
   */
  private async ensureGroup(
    row: Connector,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    principal: ExternalPrincipal,
    refreshMembers: boolean,
  ): Promise<void> {
    const key = `${row.id}:g:${principal.externalId}`;
    if (!refreshMembers && Date.now() - (this.recent.get(key) ?? 0) < RECENT_MS) return;
    this.recent.set(key, Date.now());

    let group = await this.prisma.userGroup.findUnique({
      where: { connectorId_externalId: { connectorId: row.id, externalId: principal.externalId } },
    });
    const created = !group;
    if (!group) group = await this.createGroup(row, principal);
    if (created || refreshMembers) await this.syncMembers(row, adapter, ctx, group, principal);
  }

  private async createGroup(row: Connector, principal: ExternalPrincipal): Promise<UserGroup> {
    const base = `${row.name} · ${principal.name || principal.externalId}`.slice(0, MAX_PRINCIPAL_NAME);
    const data = {
      workspaceId: row.workspaceId,
      source: 'connector',
      connectorId: row.id,
      externalId: principal.externalId,
      description: t('connector.acl.groupDescription', { connector: row.name }),
    };
    try {
      return await this.prisma.userGroup.create({ data: { ...data, name: base } });
    } catch (err) {
      // A manual group, or another connector's, already has the name.
      if (!isUniqueViolation(err)) throw err;
      const name = `${base.slice(0, MAX_PRINCIPAL_NAME - 15)} (${principal.externalId.slice(-12)})`;
      return this.prisma.userGroup.create({ data: { ...data, name } });
    }
  }

  /**
   * Replace a mirrored group's members with the people its upstream group
   * holds who are mapped here. A read failure keeps the previous membership.
   */
  private async syncMembers(
    row: Connector,
    adapter: ConnectorAdapter,
    ctx: ConnectorContext,
    group: UserGroup,
    principal: ExternalPrincipal,
  ): Promise<boolean> {
    if (!adapter.groupMembers) return false;
    let members: ExternalGroupMember[];
    try {
      members = await adapter.groupMembers(ctx, principal);
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      ctx.debug('acl: group members unreadable', { group: principal.externalId, error: (err as Error).message });
      return false;
    }
    await this.upsertIdentities(row, members);
    const mapped = members.length
      ? await this.prisma.externalIdentity.findMany({
          where: { connectorId: row.id, externalId: { in: members.map((m) => m.externalId) }, userId: { not: null } },
          select: { userId: true },
        })
      : [];
    const want = new Set(mapped.map((m) => m.userId!));
    const have = new Set(
      (await this.prisma.userGroupMember.findMany({ where: { groupId: group.id }, select: { userId: true } })).map(
        (m) => m.userId,
      ),
    );
    const add = [...want].filter((id) => !have.has(id));
    const remove = [...have].filter((id) => !want.has(id));
    if (add.length === 0 && remove.length === 0) return false;
    await this.prisma.withTransaction(async () => {
      await this.prisma.userGroupMember.deleteMany({ where: { groupId: group.id, userId: { in: remove } } });
      await this.prisma.userGroupMember.createMany({
        data: add.map((userId) => ({ groupId: group.id, userId, source: 'connector' })),
        skipDuplicates: true,
      });
    });
    return true;
  }

  // --- helpers ---

  private async plan(row: Connector, stored: StoredAcl): Promise<AclPlan> {
    const users = new Map<string, string>();
    const groups = new Map<string, string>();
    if (stored.kind === 'acl') {
      const userIds = stored.acl.principals.filter((p) => p.type === 'user').map((p) => p.externalId);
      const groupIds = stored.acl.principals.filter((p) => p.type === 'group').map((p) => p.externalId);
      const [identities, mirrored] = await Promise.all([
        userIds.length
          ? this.prisma.externalIdentity.findMany({
              where: { connectorId: row.id, externalId: { in: userIds }, userId: { not: null } },
              select: { externalId: true, userId: true },
            })
          : [],
        groupIds.length
          ? this.prisma.userGroup.findMany({
              where: { connectorId: row.id, externalId: { in: groupIds } },
              select: { id: true, externalId: true },
            })
          : [],
      ]);
      for (const i of identities) users.set(i.externalId, i.userId!);
      for (const g of mirrored) if (g.externalId) groups.set(g.externalId, g.id);
    }
    return planAcl({
      stored,
      mode: row.aclMode as Exclude<ConnectorAclMode, 'off'>,
      audienceGroupId: row.aclAudienceGroupId,
      ownerId: row.createdBy,
      users,
      groups,
    });
  }

  private warningsFor(stored: StoredAcl, plan: AclPlan): string[] {
    const warnings: string[] = [];
    if (stored.kind === 'error') warnings.push(t('connector.acl.readFailed', { error: stored.message }));
    if (plan.unmapped.length > 0) {
      warnings.push(
        t('connector.acl.unmappedPrincipal', {
          count: plan.unmapped.length,
          names: plan.unmapped.slice(0, 5).join(', ') + (plan.unmapped.length > 5 ? ', …' : ''),
        }),
      );
    }
    return warnings;
  }

  /**
   * `acl.changed`, at most once a second per workspace: a 500-page import
   * restricts 500 pages, and every live client refetches on each event.
   */
  private announce(workspaceId: string): void {
    if (this.announcing.has(workspaceId)) return;
    this.announcing.add(workspaceId);
    setTimeout(() => {
      this.announcing.delete(workspaceId);
      void this.aclEvents.changed(workspaceId).catch(() => undefined);
    }, 1_000).unref();
  }
}

function toPrincipal(group: UserGroup): ExternalPrincipal {
  return { type: 'group', externalId: group.externalId ?? '', name: group.name, level: 'view' };
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
