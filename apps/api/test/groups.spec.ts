import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WORKSPACE_ROLES } from '@knowledge/contracts';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { ROLE_ORDER, type Principal } from '../src/auth/principal.js';
import { GroupsService } from '../src/permissions/groups.service.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

/**
 * Page permissions, phase 1 (issue #76): groups and the guest role.
 *
 * What is pinned:
 * 1. **A guest is refused by the ladder, not by special cases.** `ROLE_ORDER`
 *    puts it below every route minimum, so each existing `@Access('viewer')`
 *    route refuses one without knowing guests exist.
 * 2. **A group's workspace comes from its row**, so another tenant's group id
 *    is a 403 whatever workspace the request names.
 * 3. **Group invariants the guard cannot express**: unique names as a 409,
 *    members drawn from the workspace only, and connector/SCIM groups
 *    read-only — the next sync would undo a manual edit.
 * 4. **Leaving the workspace means leaving its groups**, or re-adding a person
 *    would silently restore what their old groups were granted.
 * 5. **No notification reaches a guest**: it would carry a page title the guest
 *    may not read.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const ALICE = '44444444-4444-4444-8444-444444444444';
const BOB = '55555555-5555-4555-8555-555555555555';
const STRANGER = '66666666-6666-4666-8666-666666666666';

const caller: Principal = {
  userId: ALICE,
  email: 'alice@x.test',
  displayName: 'Alice',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};

function accessAs(role: string, workspaceId = WS) {
  return new AccessService({
    workspaceMember: {
      findUnique: vi.fn(async ({ where }: { where: { workspaceId_userId: { workspaceId: string } } }) =>
        where.workspaceId_userId.workspaceId === workspaceId ? { role, trustedOperator: false } : null,
      ),
    },
    userGroup: { findUnique: vi.fn(async () => ({ workspaceId: WS_B })) },
  } as never);
}

describe('the guest role', () => {
  it('sits below every rung, and the contract vocabulary and the ladder name the same roles', () => {
    expect(Object.keys(ROLE_ORDER).sort()).toEqual([...WORKSPACE_ROLES].sort());
    expect(ROLE_ORDER.guest).toBeLessThan(ROLE_ORDER.viewer);
  });

  it('is refused every workspace-level route, while a viewer passes', async () => {
    await expect(accessAs('guest').requireRole(caller, WS, 'viewer')).rejects.toThrow(/roleRequired/);
    await expect(accessAs('viewer').requireRole(caller, WS, 'viewer')).resolves.toBeUndefined();
  });

  it('resolves a group route’s workspace from the row, so another tenant’s group is a 403', async () => {
    const reflector = {
      getAllAndOverride: () => false,
      get: () => ({ role: 'viewer', source: 'group', operator: false }),
    };
    const guard = new AclGuard(reflector as never, accessAs('admin', WS));
    const request = { principal: caller, method: 'GET', params: { id: GROUP }, query: { workspaceId: WS }, body: {} };
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    };
    // Admin of WS, naming WS in the query; the group row says WS_B.
    await expect(guard.canActivate(ctx as never)).rejects.toThrow(/notMember/);
  });
});

// ------------------------------------------------------------------- groups

function fakePrisma(opts: { source?: string; roster?: string[] } = {}) {
  const roster = new Set(opts.roster ?? [ALICE, BOB]);
  const group = {
    id: GROUP,
    workspaceId: WS,
    name: 'Security',
    description: null as string | null,
    source: opts.source ?? 'manual',
    connectorId: null,
    externalId: null,
    createdAt: new Date('2026-10-15T00:00:00Z'),
  };
  const members: { groupId: string; userId: string; source: string; createdAt: Date }[] = [];
  const prisma = {
    group,
    members,
    userGroup: {
      findUnique: vi.fn(async () => group),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...group, ...data, _count: { members: 0 } })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...group, ...data, _count: { members: 0 } })),
      delete: vi.fn(async () => group),
    },
    userGroupMember: {
      findMany: vi.fn(async () => members),
      deleteMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) => {
        for (const id of where.userId.in) {
          const i = members.findIndex((m) => m.userId === id);
          if (i >= 0) members.splice(i, 1);
        }
      }),
      createMany: vi.fn(async ({ data }: { data: { groupId: string; userId: string }[] }) => {
        for (const row of data) {
          if (!members.some((m) => m.userId === row.userId)) {
            members.push({ ...row, source: 'manual', createdAt: new Date('2026-10-15T00:00:00Z') });
          }
        }
      }),
    },
    workspaceMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
        where.userId.in
          .filter((id) => roster.has(id))
          .map((userId) => ({
            userId,
            role: userId === BOB ? 'guest' : 'viewer',
            user: { id: userId, email: `${userId.slice(0, 4)}@x.test`, displayName: userId.slice(0, 4), avatarKey: null },
          })),
      ),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return prisma;
}

describe('GroupsService', () => {
  it('trims the name and stores a blank description as none', async () => {
    const prisma = fakePrisma();
    const summary = await new GroupsService(prisma as never).create({ workspaceId: WS, name: '  Auditors ', description: '   ' });
    expect(prisma.userGroup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { workspaceId: WS, name: 'Auditors', description: null } }),
    );
    expect(summary).toMatchObject({ name: 'Auditors', description: null, source: 'manual', memberCount: 0 });
  });

  it('answers a name clash with 409 nameTaken, from the unique index rather than a pre-check', async () => {
    const prisma = fakePrisma();
    prisma.userGroup.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );
    const error = await new GroupsService(prisma as never).create({ workspaceId: WS, name: 'Security' }).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ statusCode: 409, reason: 'group.nameTaken' });
  });

  it('adds only workspace members, and names everyone it refused', async () => {
    const service = new GroupsService(fakePrisma() as never);
    await expect(service.updateMembers(GROUP, { add: [ALICE, STRANGER] })).rejects.toThrow(/notMembers/);
  });

  it('adds and removes in one call; an id in both lists is added, and guests keep their role', async () => {
    const prisma = fakePrisma();
    const service = new GroupsService(prisma as never);
    await service.updateMembers(GROUP, { add: [ALICE, BOB] });
    const res = await service.updateMembers(GROUP, { add: [BOB], remove: [ALICE, BOB] });
    expect(res.members.map((m) => [m.userId, m.role])).toEqual([[BOB, 'guest']]);
  });

  it('does not list a member who has since left the workspace', async () => {
    const prisma = fakePrisma({ roster: [ALICE] });
    prisma.members.push({ groupId: GROUP, userId: BOB, source: 'manual', createdAt: new Date() });
    prisma.members.push({ groupId: GROUP, userId: ALICE, source: 'manual', createdAt: new Date() });
    const res = await new GroupsService(prisma as never).listMembers(GROUP);
    expect(res.members.map((m) => m.userId)).toEqual([ALICE]);
  });

  it.each(['connector', 'scim'])('refuses every edit to a %s group with 409 readOnly', async (source) => {
    const prisma = fakePrisma({ source });
    const service = new GroupsService(prisma as never);
    for (const attempt of [
      () => service.update(GROUP, { name: 'Renamed' }),
      () => service.remove(GROUP),
      () => service.updateMembers(GROUP, { add: [ALICE] }),
    ]) {
      const error = await attempt().catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ reason: 'group.readOnly', source });
    }
    expect(prisma.userGroup.update).not.toHaveBeenCalled();
    expect(prisma.userGroup.delete).not.toHaveBeenCalled();
    expect(prisma.userGroupMember.createMany).not.toHaveBeenCalled();
  });

  it('still lets anyone who can read the workspace read a synced group’s members', async () => {
    await expect(new GroupsService(fakePrisma({ source: 'connector' }) as never).listMembers(GROUP)).resolves.toMatchObject({
      groupId: GROUP,
    });
  });
});

// ------------------------------------------------------- leaving a workspace

describe('removing a workspace member', () => {
  it.each(['viewer', 'admin'])('drops their memberships in that workspace’s groups (a %s)', async (role) => {
    const deleteMany = vi.fn(async () => ({ count: 2 }));
    const prisma = {
      workspaceMember: {
        findUnique: vi.fn(async () => ({ workspaceId: WS, userId: BOB, role })),
        delete: vi.fn(async () => ({})),
        findMany: vi.fn(async () => []),
      },
      $executeRaw: vi.fn(async () => 1),
      userGroupMember: { deleteMany },
    };
    await new WorkspacesService(prisma as never).removeMember(WS, BOB);
    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: BOB, group: { workspaceId: WS } } });
  });

  it('keeps them when the removal is refused (the last admin)', async () => {
    const deleteMany = vi.fn();
    const prisma = {
      workspaceMember: { findUnique: vi.fn(async () => ({ workspaceId: WS, userId: BOB, role: 'admin' })) },
      $executeRaw: vi.fn(async () => 0),
      userGroupMember: { deleteMany },
    };
    await expect(new WorkspacesService(prisma as never).removeMember(WS, BOB)).rejects.toThrow(/lastAdminRemove/);
    expect(deleteMany).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ notifications

describe('notifications to a guest', () => {
  it('are dropped, whether the guest was mentioned or merely watching', async () => {
    const prisma = {
      workspaceMember: {
        // BOB is the guest: `role: 'guest'` finds him, `role: { not: 'guest' }` does not.
        findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] }; role?: unknown } }) =>
          where.userId.in
            .filter((id) => (where.role === 'guest' ? id === BOB : where.role ? id !== BOB : true))
            .map((userId) => ({ userId })),
        ),
      },
      notificationPreference: { findMany: vi.fn(async () => []) },
      notificationSubscription: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    };
    const service = new NotificationsService(prisma as never);
    const write = vi
      .spyOn(service as unknown as { write: (i: { userId: string }) => Promise<unknown> }, 'write')
      .mockImplementation(async (input) => ({ id: input.userId }));

    const deliveries = await service.notifyMentions({
      workspaceId: WS,
      body: 'hi',
      userIds: [ALICE, BOB],
      type: 'document.comment.created',
      actor: STRANGER,
      documentId: GROUP,
      subjectType: 'document',
      subjectId: GROUP,
      title: 'Incident review',
    });
    expect(deliveries.map((d) => d.userId)).toEqual([ALICE]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('are dropped for a watcher who has since been made a guest', async () => {
    const prisma = {
      workspaceMember: {
        findMany: vi.fn(async ({ where }: { where: { userId: { in: string[] } } }) =>
          where.userId.in.filter((id) => id === BOB).map((userId) => ({ userId })),
        ),
      },
      notificationPreference: { findMany: vi.fn(async () => []) },
    };
    const service = new NotificationsService(prisma as never);
    const deliver = (service as unknown as {
      deliver: (...a: unknown[]) => Promise<{ userId: string }[]>;
    }).deliver.bind(service);
    vi.spyOn(service as unknown as { write: (i: { userId: string }) => Promise<unknown> }, 'write').mockImplementation(
      async (input) => ({ id: input.userId }),
    );
    const deliveries = await deliver(
      { type: 'document.revision.indexed', workspaceId: WS, documentId: GROUP, title: 'Incident review', actor: STRANGER },
      'page',
      new Map([
        [ALICE, 'watching'],
        [BOB, 'watching'],
      ]),
      { workspaceId: WS, subjectType: 'document', subjectId: GROUP },
    );
    expect(deliveries.map((d) => d.userId)).toEqual([ALICE]);
  });
});
