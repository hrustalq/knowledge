import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ScimGroup } from '@prisma/client';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { normalizeDomain } from '../auth/sso/identity-providers.service.js';
import { RoleSyncService } from '../auth/sso/role-sync.service.js';
import { ScimError } from './scim-errors.js';
import { parseGroupFilter, parseUserFilter } from './scim-filter.js';
import { applyGroupPatch, applyUserPatch, readPatch, type GroupState } from './scim-patch.js';
import {
  listResponse,
  patchableUser,
  readUserDoc,
  renderGroup,
  renderUser,
  type ScimUserFields,
  type ScimUserRecord,
} from './scim-resources.js';

/** Who is calling: the workspace a `kscim_` token belongs to, and which token. */
export interface ScimCaller {
  workspaceId: string;
  tokenId: string;
}

export interface ScimPageQuery {
  filter?: string;
  startIndex?: string;
  count?: string;
  excludedAttributes?: string;
}

type Doc = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_INCLUDE = { user: { select: { email: true, displayName: true, createdAt: true } } } as const;
const GROUP_INCLUDE = { members: { include: { user: { select: { displayName: true } } } } } as const;

const notFound = (what: 'user' | 'group', id: string) =>
  new ScimError(HttpStatus.NOT_FOUND, t(what === 'user' ? 'error.scim.userNotFound' : 'error.scim.groupNotFound', { id }));
const conflict = (detail: string) => new ScimError(HttpStatus.CONFLICT, detail, 'uniqueness');
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * SCIM 2.0 Users and Groups for one workspace (#75 phase 5).
 *
 * Users are global and a SCIM client belongs to one workspace, so what a
 * client may do to the account itself is narrow:
 * - creating a user links an existing account by address (the client gains a
 *   membership for it, nothing more) or creates an SSO-only one;
 * - the global email and name, and the account's `disabled_at`, change only
 *   when the account's email domain is one this workspace has **verified**
 *   (`sso_domains`). Without that, workspace A's directory could rename,
 *   re-address or lock out a person who also works in workspace B;
 * - everything else a client says lives in `scim_users` for this workspace.
 *
 * Deactivating (`active: false`) or deleting a user takes their IdP-managed
 * membership away and revokes their sessions; a `manual` membership a person
 * granted stays. Group changes re-run role sync for the people they touch.
 */
@Injectable()
export class ScimService {
  readonly base: string;
  private readonly maxPage: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly roleSync: RoleSyncService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    config: ConfigService<Env, true>,
  ) {
    this.base = `${config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '')}/v1/scim/v2`;
    this.maxPage = config.get('AUTH_SCIM_MAX_PAGE', { infer: true });
  }

  // ------------------------------------------------------------------ users

  async listUsers(caller: ScimCaller, query: ScimPageQuery): Promise<Doc> {
    const where: Prisma.ScimUserWhereInput = { workspaceId: caller.workspaceId };
    if (query.filter) {
      const f = parseUserFilter(query.filter);
      if (!f) throw new ScimError(HttpStatus.BAD_REQUEST, t('error.scim.invalidFilter'), 'invalidFilter');
      if (f.attribute === 'id') where.userId = UUID.test(f.value) ? f.value : '00000000-0000-0000-0000-000000000000';
      else if (f.attribute === 'userName') where.userName = f.value.toLowerCase();
      else if (f.attribute === 'externalId') where.externalId = f.value;
      else where.user = { email: f.value.toLowerCase() };
    }
    const { skip, take, startIndex } = this.page(query);
    const [total, rows] = await Promise.all([
      this.prisma.scimUser.count({ where }),
      take ? this.prisma.scimUser.findMany({ where, include: USER_INCLUDE, orderBy: { userId: 'asc' }, skip, take }) : Promise.resolve([]),
    ]);
    const groups = await this.groupsOf(caller.workspaceId, rows.map((r) => r.userId));
    return listResponse(
      rows.map((r) => renderUser(this.base, r, groups.get(r.userId) ?? [])),
      total,
      startIndex,
    );
  }

  async getUser(caller: ScimCaller, id: string): Promise<Doc> {
    return this.render(caller.workspaceId, await this.loadUser(caller.workspaceId, id));
  }

  async createUser(caller: ScimCaller, body: unknown): Promise<Doc> {
    const f = readUserDoc(body);
    const ws = caller.workspaceId;
    const clash = await this.prisma.scimUser.findFirst({
      where: { workspaceId: ws, OR: [{ userName: f.userName }, ...(f.externalId ? [{ externalId: f.externalId }] : [])] },
    });
    if (clash) throw conflict(t('error.scim.userExists', { userName: f.userName }));

    const authority = await this.domainAuthority(ws, f.email);
    let user = await this.prisma.user.findUnique({ where: { email: f.email } });
    const linked = !!user;
    if (user) {
      if (await this.prisma.scimUser.findUnique({ where: { workspaceId_userId: { workspaceId: ws, userId: user.id } } })) {
        throw conflict(t('error.scim.emailProvisioned', { email: f.email }));
      }
      if (authority && user.displayName !== f.displayName) {
        user = await this.prisma.user.update({ where: { id: user.id }, data: { displayName: f.displayName } });
      }
    } else {
      try {
        user = await this.prisma.user.create({
          data: {
            email: f.email,
            displayName: f.displayName,
            // SSO-only until the person sets one; SCIM never carries passwords here.
            passwordHash: null,
            // A verified domain is the workspace's word that the address is real.
            emailVerifiedAt: authority ? new Date() : null,
          },
        });
      } catch (e) {
        if (isUnique(e)) throw conflict(t('error.scim.emailProvisioned', { email: f.email }));
        throw e;
      }
    }

    try {
      await this.prisma.scimUser.create({
        data: { workspaceId: ws, userId: user.id, userName: f.userName, externalId: f.externalId, active: f.active, raw: f.raw as Prisma.InputJsonValue },
      });
    } catch (e) {
      if (isUnique(e)) throw conflict(t('error.scim.userExists', { userName: f.userName }));
      throw e;
    }
    void this.audit.record({
      workspaceId: ws,
      actor: 'scim',
      action: 'scim.user_created',
      params: { tokenId: caller.tokenId, userName: f.userName, email: f.email, linked, active: f.active },
      ok: true,
      target: user.id,
    });
    if (!f.active) await this.offboard(user.id, authority);
    await this.roleSync.applyScim(ws, [user.id]);
    return this.render(ws, await this.loadUser(ws, user.id));
  }

  async replaceUser(caller: ScimCaller, id: string, body: unknown): Promise<Doc> {
    const rec = await this.loadUser(caller.workspaceId, id);
    return this.update(caller, rec, readUserDoc(body));
  }

  async patchUser(caller: ScimCaller, id: string, body: unknown): Promise<Doc> {
    const rec = await this.loadUser(caller.workspaceId, id);
    const ops = readPatch(body);
    const current = patchableUser(await this.render(caller.workspaceId, rec));
    return this.update(caller, rec, readUserDoc(applyUserPatch(current, ops)));
  }

  async deleteUser(caller: ScimCaller, id: string): Promise<void> {
    const ws = caller.workspaceId;
    const rec = await this.loadUser(ws, id);
    const authority = await this.domainAuthority(ws, rec.user.email);
    await this.prisma.scimGroupMember.deleteMany({ where: { userId: rec.userId, group: { workspaceId: ws } } });
    await this.prisma.scimUser.deleteMany({ where: { workspaceId: ws, userId: rec.userId } });
    await this.roleSync.applyScim(ws, [rec.userId]);
    const disabled = await this.offboard(rec.userId, authority);
    void this.audit.record({
      workspaceId: ws,
      actor: 'scim',
      action: 'scim.user_deleted',
      params: { tokenId: caller.tokenId, userName: rec.userName, accountDisabled: disabled },
      ok: true,
      target: rec.userId,
    });
  }

  private async update(caller: ScimCaller, rec: ScimUserRecord, f: ScimUserFields): Promise<Doc> {
    const ws = caller.workspaceId;
    const others = { workspaceId: ws, userId: { not: rec.userId } };
    if (f.userName !== rec.userName && (await this.prisma.scimUser.findFirst({ where: { ...others, userName: f.userName } }))) {
      throw conflict(t('error.scim.userExists', { userName: f.userName }));
    }
    if (f.externalId && f.externalId !== rec.externalId && (await this.prisma.scimUser.findFirst({ where: { ...others, externalId: f.externalId } }))) {
      throw conflict(t('error.scim.externalIdExists', { externalId: f.externalId }));
    }

    // The global account moves only under a domain this workspace has proven.
    const authority = await this.domainAuthority(ws, rec.user.email);
    const account: Prisma.UserUpdateInput = {};
    if (authority && f.email !== rec.user.email) account.email = f.email;
    if (authority && f.displayName !== rec.user.displayName) account.displayName = f.displayName;
    if (Object.keys(account).length) {
      try {
        await this.prisma.user.update({ where: { id: rec.userId }, data: account });
      } catch (e) {
        if (isUnique(e)) throw conflict(t('error.scim.emailProvisioned', { email: f.email }));
        throw e;
      }
    }

    try {
      await this.prisma.scimUser.update({
        where: { workspaceId_userId: { workspaceId: ws, userId: rec.userId } },
        data: { userName: f.userName, externalId: f.externalId, active: f.active, raw: f.raw as Prisma.InputJsonValue },
      });
    } catch (e) {
      if (isUnique(e)) throw conflict(t('error.scim.userExists', { userName: f.userName }));
      throw e;
    }

    const changed = [
      ...(f.userName !== rec.userName ? ['userName'] : []),
      ...(f.externalId !== rec.externalId ? ['externalId'] : []),
      ...(f.active !== rec.active ? ['active'] : []),
      ...Object.keys(account),
    ];
    if (f.active !== rec.active) await this.roleSync.applyScim(ws, [rec.userId]);
    if (!f.active && rec.active) {
      const disabled = await this.offboard(rec.userId, authority);
      void this.audit.record({
        workspaceId: ws,
        actor: 'scim',
        action: 'scim.user_deactivated',
        params: { tokenId: caller.tokenId, userName: f.userName, changed, accountDisabled: disabled },
        ok: true,
        target: rec.userId,
      });
    } else if (changed.length) {
      if (f.active && !rec.active) await this.reinstate(rec.userId, authority);
      void this.audit.record({
        workspaceId: ws,
        actor: 'scim',
        action: 'scim.user_updated',
        params: { tokenId: caller.tokenId, userName: f.userName, changed },
        ok: true,
        target: rec.userId,
      });
    }
    return this.render(ws, await this.loadUser(ws, rec.userId));
  }

  /**
   * Sessions end everywhere — they are not per workspace — and the account is
   * disabled only under a verified domain. Returns whether it was disabled.
   */
  private async offboard(userId: string, authority: boolean): Promise<boolean> {
    await this.sessions.revokeAllForUser(userId);
    if (!authority) return false;
    const { count } = await this.prisma.user.updateMany({ where: { id: userId, disabledAt: null }, data: { disabledAt: new Date() } });
    return count > 0;
  }

  /** The reverse of {@link offboard}, under the same domain rule. */
  private async reinstate(userId: string, authority: boolean): Promise<void> {
    if (authority) await this.prisma.user.updateMany({ where: { id: userId, disabledAt: { not: null } }, data: { disabledAt: null } });
  }

  /** The account's email domain is verified by this workspace. */
  private async domainAuthority(workspaceId: string, email: string): Promise<boolean> {
    const domain = normalizeDomain(email.slice(email.lastIndexOf('@') + 1));
    if (!domain) return false;
    const row = await this.prisma.ssoDomain.findFirst({ where: { domain, workspaceId, verifiedAt: { not: null } } });
    return !!row;
  }

  private async loadUser(workspaceId: string, id: string): Promise<ScimUserRecord> {
    const rec = UUID.test(id)
      ? await this.prisma.scimUser.findUnique({ where: { workspaceId_userId: { workspaceId, userId: id } }, include: USER_INCLUDE })
      : null;
    if (!rec) throw notFound('user', id);
    return rec;
  }

  private async render(workspaceId: string, rec: ScimUserRecord): Promise<Doc> {
    const groups = await this.groupsOf(workspaceId, [rec.userId]);
    return renderUser(this.base, rec, groups.get(rec.userId) ?? []);
  }

  private async groupsOf(workspaceId: string, userIds: string[]): Promise<Map<string, { id: string; displayName: string }[]>> {
    const out = new Map<string, { id: string; displayName: string }[]>();
    if (!userIds.length) return out;
    const rows = await this.prisma.scimGroupMember.findMany({
      where: { userId: { in: userIds }, group: { workspaceId } },
      include: { group: { select: { id: true, displayName: true } } },
    });
    for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.group]);
    return out;
  }

  // ----------------------------------------------------------------- groups

  async listGroups(caller: ScimCaller, query: ScimPageQuery): Promise<Doc> {
    const where: Prisma.ScimGroupWhereInput = { workspaceId: caller.workspaceId };
    if (query.filter) {
      const f = parseGroupFilter(query.filter);
      if (!f) throw new ScimError(HttpStatus.BAD_REQUEST, t('error.scim.invalidFilter'), 'invalidFilter');
      if (f.attribute === 'id') where.id = UUID.test(f.value) ? f.value : '00000000-0000-0000-0000-000000000000';
      else if (f.attribute === 'displayName') where.displayName = { equals: f.value, mode: 'insensitive' };
      else where.externalId = f.value;
    }
    const withMembers = !excludes(query.excludedAttributes, 'members');
    const { skip, take, startIndex } = this.page(query);
    const [total, rows] = await Promise.all([
      this.prisma.scimGroup.count({ where }),
      take
        ? this.prisma.scimGroup.findMany({ where, include: GROUP_INCLUDE, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], skip, take })
        : Promise.resolve([]),
    ]);
    return listResponse(rows.map((g) => renderGroup(this.base, g, withMembers)), total, startIndex);
  }

  async getGroup(caller: ScimCaller, id: string, excludedAttributes?: string): Promise<Doc> {
    return renderGroup(this.base, await this.loadGroup(caller.workspaceId, id), !excludes(excludedAttributes, 'members'));
  }

  async createGroup(caller: ScimCaller, body: unknown): Promise<Doc> {
    const ws = caller.workspaceId;
    const next = applyGroupPatch({ displayName: '', externalId: null, members: new Set() }, [{ op: 'replace', value: groupBody(body) }]);
    if (!next.displayName) throw new ScimError(HttpStatus.BAD_REQUEST, t('error.scim.displayNameRequired'), 'invalidValue');
    let group: ScimGroup;
    try {
      group = await this.prisma.scimGroup.create({ data: { workspaceId: ws, displayName: next.displayName, externalId: next.externalId } });
    } catch (e) {
      if (isUnique(e)) throw conflict(t('error.scim.groupExists', { displayName: next.displayName }));
      throw e;
    }
    const { added, skipped } = await this.writeMembers(ws, group.id, new Set(), next.members);
    void this.audit.record({
      workspaceId: ws,
      actor: 'scim',
      action: 'scim.group_created',
      params: { tokenId: caller.tokenId, displayName: next.displayName, members: added.length, skipped },
      ok: true,
      target: group.id,
    });
    await this.roleSync.applyScim(ws, added);
    return renderGroup(this.base, await this.loadGroup(ws, group.id));
  }

  async replaceGroup(caller: ScimCaller, id: string, body: unknown): Promise<Doc> {
    const group = await this.loadGroup(caller.workspaceId, id);
    const next = applyGroupPatch({ displayName: group.displayName, externalId: null, members: new Set() }, [
      { op: 'replace', value: groupBody(body) },
    ]);
    return this.writeGroup(caller, group, next);
  }

  async patchGroup(caller: ScimCaller, id: string, body: unknown): Promise<Doc> {
    const group = await this.loadGroup(caller.workspaceId, id);
    const current: GroupState = { displayName: group.displayName, externalId: group.externalId, members: new Set(group.members.map((m) => m.userId)) };
    return this.writeGroup(caller, group, applyGroupPatch(current, readPatch(body)));
  }

  async deleteGroup(caller: ScimCaller, id: string): Promise<void> {
    const ws = caller.workspaceId;
    const group = await this.loadGroup(ws, id);
    await this.prisma.scimGroup.delete({ where: { id: group.id } });
    // A SCIM mapping names the group by id; without the group it can never match again.
    await this.prisma.idpGroupMapping.deleteMany({ where: { workspaceId: ws, providerId: null, externalGroup: group.id } });
    void this.audit.record({
      workspaceId: ws,
      actor: 'scim',
      action: 'scim.group_deleted',
      params: { tokenId: caller.tokenId, displayName: group.displayName, members: group.members.length },
      ok: true,
      target: group.id,
    });
    await this.roleSync.applyScim(ws, group.members.map((m) => m.userId));
  }

  private async writeGroup(caller: ScimCaller, group: Awaited<ReturnType<ScimService['loadGroup']>>, next: GroupState): Promise<Doc> {
    const ws = caller.workspaceId;
    if (next.displayName !== group.displayName || next.externalId !== group.externalId) {
      try {
        await this.prisma.scimGroup.update({ where: { id: group.id }, data: { displayName: next.displayName, externalId: next.externalId } });
      } catch (e) {
        if (isUnique(e)) throw conflict(t('error.scim.groupExists', { displayName: next.displayName }));
        throw e;
      }
    }
    const { added, removed, skipped } = await this.writeMembers(ws, group.id, new Set(group.members.map((m) => m.userId)), next.members);
    void this.audit.record({
      workspaceId: ws,
      actor: 'scim',
      action: 'scim.group_updated',
      params: {
        tokenId: caller.tokenId,
        displayName: next.displayName,
        ...(next.displayName !== group.displayName ? { renamedFrom: group.displayName } : {}),
        added: added.length,
        removed: removed.length,
        skipped,
      },
      ok: true,
      target: group.id,
    });
    await this.roleSync.applyScim(ws, [...added, ...removed]);
    return renderGroup(this.base, await this.loadGroup(ws, group.id));
  }

  /**
   * Make the group's members `wanted`. Only people this workspace has
   * provisioned can be members; any other id is skipped and counted, never an
   * error, because a client may push a group before every member exists.
   */
  private async writeMembers(
    workspaceId: string,
    groupId: string,
    current: Set<string>,
    wanted: Set<string>,
  ): Promise<{ added: string[]; removed: string[]; skipped: number }> {
    const candidates = [...wanted].filter((id) => UUID.test(id) && !current.has(id));
    const provisioned = candidates.length
      ? await this.prisma.scimUser.findMany({ where: { workspaceId, userId: { in: candidates } }, select: { userId: true } })
      : [];
    const added = provisioned.map((p) => p.userId);
    const removed = [...current].filter((id) => !wanted.has(id));
    if (added.length) {
      await this.prisma.scimGroupMember.createMany({ data: added.map((userId) => ({ groupId, userId })), skipDuplicates: true });
    }
    if (removed.length) await this.prisma.scimGroupMember.deleteMany({ where: { groupId, userId: { in: removed } } });
    return { added, removed, skipped: [...wanted].filter((id) => !current.has(id)).length - added.length };
  }

  private async loadGroup(workspaceId: string, id: string) {
    const group = UUID.test(id) ? await this.prisma.scimGroup.findFirst({ where: { id, workspaceId }, include: GROUP_INCLUDE }) : null;
    if (!group) throw notFound('group', id);
    return group;
  }

  /** RFC 7644 §3.4.2.4: 1-based `startIndex`, `count` capped by AUTH_SCIM_MAX_PAGE; `count=0` is a total only. */
  private page(query: ScimPageQuery): { skip: number; take: number; startIndex: number } {
    const startIndex = Math.max(1, Number.parseInt(query.startIndex ?? '1', 10) || 1);
    const asked = query.count === undefined ? this.maxPage : Number.parseInt(query.count, 10);
    const take = Math.min(Math.max(Number.isFinite(asked) ? asked : this.maxPage, 0), this.maxPage);
    return { skip: startIndex - 1, take, startIndex };
  }
}

function excludes(list: string | undefined, attr: string): boolean {
  return !!list && list.split(',').some((a) => a.trim().toLowerCase() === attr);
}

/** A group POST/PUT body as one replace: the same reader a PATCH value goes through. */
function groupBody(body: unknown): Doc {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ScimError(HttpStatus.BAD_REQUEST, t('error.scim.bodyObject'), 'invalidSyntax');
  }
  return body as Doc;
}
