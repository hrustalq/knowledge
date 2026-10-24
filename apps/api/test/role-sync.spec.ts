import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { RoleSyncService } from '../src/auth/sso/role-sync.service.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';

/**
 * IdP groups → workspace roles (#75 phase 3). What is pinned:
 * - the highest mapped role wins, and any matching mapping grants the operator flag;
 * - no mapping hit falls back to the JIT default role, in the provider's own workspace only;
 * - additive only raises; authoritative demotes and removes, but never on an unknown group list;
 * - a manual row is never touched, a scim row is left to provisioning;
 * - demoting or removing the last admin is skipped and audited, never thrown;
 * - another workspace's mapping counts only while the provider is platform-wide;
 * - a hand edit of a managed row is a 409 unless it converts the row to manual;
 * - capabilities (#468) are manual-only: sync never writes them, and editing them alone needs no takeover.
 */

const HOME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = Record<string, any>;

/**
 * workspace_members in memory, with the two guarded statements of
 * membership-guards.ts reimplemented over it — values in the order the
 * tagged templates bind them.
 */
function fakeDb(members: Row[], mappings: Row[] = []) {
  const db = { members: members.map((m) => ({ trustedOperator: false, source: 'manual', ...m })), mappings };
  const find = (ws: string, user: string) => db.members.find((m) => m.workspaceId === ws && m.userId === user);
  const otherAdmin = (ws: string, user: string) => db.members.some((m) => m.workspaceId === ws && m.role === 'admin' && m.userId !== user);
  const prisma = {
    idpGroupMapping: { findMany: vi.fn(async ({ where }: Row) => db.mappings.filter((m) => m.providerId === where.providerId)) },
    workspaceMember: {
      findMany: vi.fn(async ({ where }: Row) =>
        db.members.filter((m) => m.userId === where.userId && (!where.workspaceId || where.workspaceId.in.includes(m.workspaceId))),
      ),
      findUnique: vi.fn(async ({ where }: Row) => find(where.workspaceId_userId.workspaceId, where.workspaceId_userId.userId) ?? null),
      createMany: vi.fn(async ({ data }: Row) => {
        let count = 0;
        for (const m of data as Row[]) {
          if (!find(m.workspaceId, m.userId)) {
            db.members.push({ trustedOperator: false, source: 'manual', ...m });
            count++;
          }
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: Row) => {
        const row = find(where.workspaceId, where.userId);
        if (!row || (where.source && !where.source.in.includes(row.source))) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: Row) => Object.assign(find(where.workspaceId_userId.workspaceId, where.workspaceId_userId.userId)!, data)),
    },
    user: { findUnique: vi.fn(async () => ({ id: ADA })) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('UPDATE workspace_members')) {
        const [role, ws, user, sources] = v as [string, string, string, string[] | null];
        const row = find(ws, user);
        if (!row || (sources && !sources.includes(row.source))) return 0;
        if (row.role === 'admin' && role !== 'admin' && !otherAdmin(ws, user)) return 0;
        row.role = role;
        return 1;
      }
      if (sql.includes('DELETE FROM workspace_members')) {
        const [ws, user, sources] = v as [string, string, string[] | null];
        const row = find(ws, user);
        if (!row || (sources && !sources.includes(row.source))) return 0;
        if (row.role === 'admin' && !otherAdmin(ws, user)) return 0;
        db.members.splice(db.members.indexOf(row), 1);
        return 1;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    userGroupMember: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    accessGrant: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { db, prisma };
}

const provider = (over: Row = {}) => ({
  id: 'p1',
  workspaceId: HOME,
  platformWide: false,
  jitEnabled: false,
  defaultRole: null,
  groupSyncMode: 'additive',
  ...over,
});
const mapping = (externalGroup: string, role: string, over: Row = {}) => ({
  id: `m-${externalGroup}`,
  workspaceId: HOME,
  providerId: 'p1',
  externalGroup,
  role,
  trustedOperator: false,
  ...over,
});

function sync(members: Row[], mappings: Row[] = []) {
  const { db, prisma } = fakeDb(members, mappings);
  const audit = { record: vi.fn(async () => undefined) };
  const service = new RoleSyncService(prisma as never, audit as never);
  const run = (p: Row, groups: string[], groupsKnown = true) =>
    service.apply({ provider: p as never, userId: ADA, groups, groupsKnown });
  const entries = (action: string) => (audit.record.mock.calls as unknown as Row[][]).map((c) => c[0]).filter((e) => e.action === action);
  const ada = (ws = HOME) => db.members.find((m) => m.userId === ADA && m.workspaceId === ws);
  return { db, run, entries, ada };
}

describe('RoleSyncService', () => {
  it('the highest mapped role wins, and any matching mapping grants the operator flag', async () => {
    const s = sync([], [mapping('readers', 'viewer'), mapping('writers', 'editor'), mapping('ops', 'viewer', { trustedOperator: true }), mapping('admins', 'admin')]);
    const changes = await s.run(provider(), ['readers', 'writers', 'ops', 'unmapped']);
    expect(changes).toEqual([{ workspaceId: HOME, kind: 'added' }]);
    expect(s.ada()).toMatchObject({ role: 'editor', trustedOperator: true, source: 'group' });
    expect(s.entries('role_sync.applied')[0]).toMatchObject({
      workspaceId: HOME,
      target: ADA,
      params: { providerId: 'p1', before: null, matchedGroups: expect.arrayContaining(['readers', 'writers', 'ops']) },
    });
  });

  it('with no mapping hit falls back to the JIT default role, and without one grants nothing', async () => {
    const s = sync([], [mapping('admins', 'admin')]);
    await s.run(provider({ jitEnabled: true, defaultRole: 'viewer' }), ['someone-else']);
    expect(s.ada()).toMatchObject({ role: 'viewer', source: 'jit' });

    const none = sync([], [mapping('admins', 'admin')]);
    expect(await none.run(provider({ jitEnabled: false, defaultRole: 'viewer' }), [])).toEqual([]);
    expect(none.ada()).toBeUndefined();
  });

  describe('additive', () => {
    it('raises a role but never lowers it, and keeps a row whose groups vanished', async () => {
      const s = sync([{ workspaceId: HOME, userId: ADA, role: 'editor', source: 'group' }], [mapping('readers', 'viewer'), mapping('admins', 'admin')]);
      expect(await s.run(provider(), ['readers'])).toEqual([]);
      expect(s.ada()).toMatchObject({ role: 'editor' });

      expect(await s.run(provider(), [])).toEqual([]);
      expect(s.ada()).toMatchObject({ role: 'editor' });

      expect(await s.run(provider(), ['admins'])).toEqual([{ workspaceId: HOME, kind: 'updated' }]);
      expect(s.ada()).toMatchObject({ role: 'admin', source: 'group' });
    });
  });

  describe('authoritative', () => {
    const auth = provider({ groupSyncMode: 'authoritative' });

    it('demotes to what the groups say and removes the row when they say nothing', async () => {
      const s = sync([{ workspaceId: HOME, userId: ADA, role: 'editor', trustedOperator: true, source: 'group' }], [mapping('readers', 'viewer')]);
      await s.run(auth, ['readers']);
      expect(s.ada()).toMatchObject({ role: 'viewer', trustedOperator: false, source: 'group' });

      expect(await s.run(auth, [])).toEqual([{ workspaceId: HOME, kind: 'removed' }]);
      expect(s.ada()).toBeUndefined();
      expect(s.entries('role_sync.applied').at(-1)).toMatchObject({ params: { before: { role: 'viewer' }, after: null } });
    });

    it('takes nothing away when the IdP could not list the groups (Entra overage), and says so', async () => {
      const s = sync([{ workspaceId: HOME, userId: ADA, role: 'editor', source: 'group' }], [mapping('readers', 'viewer')]);
      expect(await s.run(auth, [], false)).toEqual([]);
      expect(s.ada()).toMatchObject({ role: 'editor' });
      expect(s.entries('role_sync.applied')).toEqual([expect.objectContaining({ params: expect.objectContaining({ groupsUnknown: true }) })]);
    });

    it('skips demoting or removing the last admin, audits it, and does not throw', async () => {
      const s = sync([{ workspaceId: HOME, userId: ADA, role: 'admin', source: 'group' }], [mapping('readers', 'viewer')]);
      expect(await s.run(auth, ['readers'])).toEqual([{ workspaceId: HOME, kind: 'blocked' }]);
      expect(await s.run(auth, [])).toEqual([{ workspaceId: HOME, kind: 'blocked' }]);
      expect(s.ada()).toMatchObject({ role: 'admin' });
      expect(s.entries('role_sync.blocked_last_admin')).toHaveLength(2);
      expect(s.entries('role_sync.blocked_last_admin')[0]).toMatchObject({ ok: false, error: 'last-admin', params: { wanted: { role: 'viewer' } } });

      // With another admin present the same demotion goes through.
      s.db.members.push({ workspaceId: HOME, userId: BOB, role: 'admin', trustedOperator: false, source: 'manual' });
      await s.run(auth, ['readers']);
      expect(s.ada()).toMatchObject({ role: 'viewer' });
    });
  });

  it.each(['additive', 'authoritative'])('never touches a manual or a scim row (%s)', async (mode) => {
    for (const source of ['manual', 'scim']) {
      const s = sync([{ workspaceId: HOME, userId: ADA, role: 'viewer', source }], [mapping('admins', 'admin')]);
      expect(await s.run(provider({ groupSyncMode: mode }), ['admins'])).toEqual([]);
      expect(await s.run(provider({ groupSyncMode: mode }), [])).toEqual([]);
      expect(s.ada()).toMatchObject({ role: 'viewer', source });
    }
  });

  it("counts another workspace's mapping only while the provider is platform-wide", async () => {
    const foreign = [mapping('staff', 'editor', { workspaceId: OTHER })];
    const scoped = sync([], foreign);
    expect(await scoped.run(provider(), ['staff'])).toEqual([]);
    expect(scoped.ada(OTHER)).toBeUndefined();

    const wide = sync([], foreign);
    expect(await wide.run(provider({ platformWide: true }), ['staff'])).toEqual([{ workspaceId: OTHER, kind: 'added' }]);
    expect(wide.ada(OTHER)).toMatchObject({ role: 'editor', source: 'group' });
    // The default role belongs to the provider's own workspace only.
    const jit = sync([], foreign);
    await jit.run(provider({ platformWide: true, jitEnabled: true, defaultRole: 'viewer' }), []);
    expect(jit.ada(HOME)).toMatchObject({ role: 'viewer', source: 'jit' });
    expect(jit.ada(OTHER)).toBeUndefined();
  });
});

describe('editing an IdP-managed member by hand', () => {
  function service(source: string) {
    const { db, prisma } = fakeDb([{ workspaceId: HOME, userId: ADA, role: 'editor', source }]);
    const listMembers = vi.fn(async () => ({ workspaceId: HOME, members: [] }));
    const audit = { record: vi.fn(async () => undefined) };
    const workspaces = new WorkspacesService(prisma as never, audit as never);
    Object.assign(workspaces, { listMembers });
    return { db, workspaces, audit };
  }

  it.each(['jit', 'group', 'scim'])('a %s row answers 409 managedByIdp', async (source) => {
    const { db, workspaces } = service(source);
    const err = await workspaces.updateMember(HOME, ADA, { role: 'viewer' }, BOB).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ statusCode: 409, source });
    expect(db.members[0]).toMatchObject({ role: 'editor', source });
  });

  it('converting it to manual applies the change and hands the row to people', async () => {
    const { db, workspaces } = service('group');
    await workspaces.updateMember(HOME, ADA, { role: 'viewer', convertToManual: true }, BOB);
    expect(db.members[0]).toMatchObject({ role: 'viewer', source: 'manual' });
  });

  it('re-adding an existing member goes through the same guards', async () => {
    const { db, workspaces } = service('jit');
    await expect(workspaces.addMember(HOME, { email: 'ada@corp.example', role: 'admin' }, BOB)).rejects.toBeInstanceOf(ConflictException);
    expect(db.members[0]).toMatchObject({ role: 'editor' });
  });

  it('a capability alone is edited on a managed row without a takeover, and audited', async () => {
    const { db, workspaces, audit } = service('scim');
    await workspaces.updateMember(HOME, ADA, { capabilities: ['api-test-suites.generate'] }, BOB);
    expect(db.members[0]).toMatchObject({ role: 'editor', source: 'scim', capabilities: ['api-test-suites.generate'] });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'member.capabilities_changed', actor: BOB, target: ADA, params: { granted: ['api-test-suites.generate'], revoked: [] } }),
    );
    await workspaces.updateMember(HOME, ADA, { capabilities: ['api-test-suites.generate'] }, BOB);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('role sync and capabilities (#468)', () => {
  const CAP = ['api-test-suites.generate'];

  it('additive and authoritative sync leave a member capabilities alone', async () => {
    const up = sync([{ workspaceId: HOME, userId: ADA, role: 'viewer', source: 'group', capabilities: CAP }], [mapping('admins', 'admin')]);
    await up.run(provider(), ['admins']);
    expect(up.ada()).toMatchObject({ role: 'admin', capabilities: CAP });

    const down = sync(
      [
        { workspaceId: HOME, userId: ADA, role: 'editor', source: 'group', capabilities: CAP },
        { workspaceId: HOME, userId: BOB, role: 'admin' },
      ],
      [mapping('readers', 'viewer', { trustedOperator: true })],
    );
    await down.run(provider({ groupSyncMode: 'authoritative' }), ['readers']);
    expect(down.ada()).toMatchObject({ role: 'viewer', trustedOperator: true, capabilities: CAP });
  });
});
