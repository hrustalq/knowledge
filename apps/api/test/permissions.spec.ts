import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  canSee,
  levelOn,
  visibilityWhere,
  type AccessIdentity,
  type AccessScope,
  type ChainNode,
  type GrantRow,
  type VisibilityRow,
} from '../src/permissions/access-scope.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { ResourceAccessService } from '../src/permissions/resource-access.service.js';
import { AccessService } from '../src/auth/access.service.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Page permissions, phase 2 (issue #76): restrictions, grants and the one
 * visibility predicate every list reads.
 *
 * What is pinned:
 * 1. **Intersective inheritance.** A reader must pass every restricted node on
 *    project → root → … → page; a child narrows and never re-opens.
 * 2. **The workspace role is the ceiling.** A viewer with an edit grant reads;
 *    edit is decided by the nearest restricted node that names editors.
 * 3. **Guests reach only what is granted**, at no more than edit.
 * 4. **Admins see everything**, and a read-only key caps it all at view.
 * 5. **The predicate's two spellings agree.** `canSee` (memory) and
 *    `visibilityWhere` (Prisma) are evaluated over the same rows here; a
 *    second spelling of an ACL is only safe while something proves that.
 * 6. **The guard's answers leak nothing**: 404 for a guest, 403 with
 *    `canRequestAccess` and no title for a member.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ALICE = '44444444-4444-4444-8444-444444444444';
const BOB = '55555555-5555-4555-8555-555555555555';
const SECURITY = '66666666-6666-4666-8666-666666666666';

function who(over: Partial<AccessIdentity> = {}): AccessIdentity {
  return { userId: ALICE, role: 'editor', bypass: false, guest: false, readOnly: false, groupIds: new Set(), ...over };
}

const chain = (restricted: { project?: boolean; root?: boolean; child?: boolean } = {}): ChainNode[] => [
  { type: 'project', id: PROJECT, restricted: restricted.project ?? false },
  { type: 'document', id: ROOT, restricted: restricted.root ?? false },
  { type: 'document', id: CHILD, restricted: restricted.child ?? false },
];

const grant = (resourceId: string, subject: string, level: string, subjectType = 'user'): GrantRow => ({
  resourceId,
  subjectType,
  subjectId: subject,
  level,
});

describe('levelOn', () => {
  it('reproduces the workspace role on an unrestricted chain', () => {
    expect(levelOn(who({ role: 'viewer' }), chain(), [])).toBe('view');
    expect(levelOn(who({ role: 'editor' }), chain(), [])).toBe('manage');
    expect(levelOn(who({ role: 'admin', bypass: true }), chain(), [])).toBe('manage');
  });

  it('shuts a reader out of a restricted page they hold no grant on — and its whole subtree', () => {
    const grants = [grant(ROOT, BOB, 'view')];
    expect(levelOn(who(), chain({ root: true }), grants)).toBe('none');
    expect(levelOn(who({ userId: BOB, role: 'viewer' }), chain({ root: true }), grants)).toBe('view');
  });

  it('is intersective: a child restricted to Alice under a parent restricted to a group admits only both', () => {
    const grants = [grant(ROOT, SECURITY, 'view', 'group'), grant(CHILD, ALICE, 'view'), grant(CHILD, BOB, 'view')];
    const restricted = chain({ root: true, child: true });
    expect(levelOn(who({ groupIds: new Set([SECURITY]) }), restricted, grants)).not.toBe('none');
    // Bob is named on the child but is not in the parent's group.
    expect(levelOn(who({ userId: BOB }), restricted, grants)).toBe('none');
    // In the group but not named on the child.
    expect(levelOn(who({ userId: 'x', groupIds: new Set([SECURITY]) }), restricted, grants)).toBe('none');
  });

  it('keeps the workspace role as the ceiling: a viewer with an edit grant still reads', () => {
    expect(levelOn(who({ role: 'viewer' }), chain({ root: true }), [grant(ROOT, ALICE, 'edit')])).toBe('view');
  });

  it('lets only the edit grantees of the nearest edit-naming node edit beneath it', () => {
    const grants = [grant(ROOT, SECURITY, 'view', 'group'), grant(ROOT, BOB, 'edit')];
    const restricted = chain({ root: true });
    expect(levelOn(who({ groupIds: new Set([SECURITY]) }), restricted, grants)).toBe('view');
    // Bob edits, and with no manage grant anywhere on the chain an editor manages too.
    expect(levelOn(who({ userId: BOB }), restricted, grants)).toBe('manage');
  });

  it('gives manage to the holders of a manage grant once the chain names one', () => {
    const grants = [grant(ROOT, BOB, 'manage'), grant(ROOT, ALICE, 'edit')];
    expect(levelOn(who({ userId: BOB }), chain({ root: true }), grants)).toBe('manage');
    expect(levelOn(who(), chain({ root: true }), grants)).toBe('edit');
  });

  it('lets a guest reach only granted pages, at the granted level capped at edit', () => {
    const guest = who({ role: 'guest', guest: true });
    expect(levelOn(guest, chain(), [])).toBe('none');
    expect(levelOn(guest, chain(), [grant(CHILD, ALICE, 'view')])).toBe('view');
    expect(levelOn(guest, chain(), [grant(ROOT, ALICE, 'manage')])).toBe('edit');
    // A grant below does not open what is above.
    expect(levelOn(guest, chain().slice(0, 2), [grant(CHILD, ALICE, 'view')])).toBe('none');
  });

  it('lets admins through everything, and caps a read-only key at view', () => {
    expect(levelOn(who({ role: 'admin', bypass: true }), chain({ root: true }), [])).toBe('manage');
    expect(levelOn(who({ role: 'admin', bypass: true, readOnly: true }), chain({ root: true }), [])).toBe('view');
    expect(levelOn(who({ readOnly: true }), chain(), [])).toBe('view');
  });
});

// ------------------------------------------------------- the two spellings

/** Just the Prisma operators `visibilityWhere` emits, evaluated over one row. */
function matches(where: Prisma.DocumentWhereInput, row: VisibilityRow & { id: string }): boolean {
  return Object.entries(where).every(([key, value]) => {
    const v = value as Record<string, unknown>;
    switch (key) {
      case 'AND':
        return (value as Prisma.DocumentWhereInput[]).every((w) => matches(w, row));
      case 'OR':
        return (value as Prisma.DocumentWhereInput[]).some((w) => matches(w, row));
      case 'NOT':
        return !matches(value as Prisma.DocumentWhereInput, row);
      case 'restrictedBy':
        return (v.hasSome as string[]).some((id) => row.restrictedBy.includes(id));
      case 'projectId':
        return (v.in as string[]).includes(row.projectId);
      case 'path':
        return row.path.includes(v.contains as string);
      case 'id':
        return (v.in as string[]).includes(row.id);
      default:
        throw new Error(`visibilityWhere emitted an operator this spec does not model: ${key}`);
    }
  });
}

describe('canSee and visibilityWhere', () => {
  const rows: (VisibilityRow & { id: string })[] = [
    { id: ROOT, projectId: PROJECT, path: `/${ROOT}/`, restrictedBy: [] },
    { id: CHILD, projectId: PROJECT, path: `/${ROOT}/${CHILD}/`, restrictedBy: [CHILD] },
    { id: 'd3', projectId: PROJECT, path: `/${ROOT}/${CHILD}/d3/`, restrictedBy: [CHILD] },
    { id: 'd4', projectId: 'p2', path: '/d4/', restrictedBy: ['p2'] },
  ];
  const scopes: Record<string, AccessScope> = {
    admin: { ...who({ bypass: true }), workspaceId: WS, denied: new Set([CHILD, 'p2']), granted: new Set() },
    member: { ...who(), workspaceId: WS, denied: new Set([CHILD, 'p2']), granted: new Set() },
    grantee: { ...who(), workspaceId: WS, denied: new Set(['p2']), granted: new Set([CHILD]) },
    'guest granted the child': {
      ...who({ guest: true, role: 'guest' }),
      workspaceId: WS,
      denied: new Set(['p2']),
      granted: new Set([CHILD]),
    },
    'guest granted nothing': { ...who({ guest: true, role: 'guest' }), workspaceId: WS, denied: new Set([CHILD, 'p2']), granted: new Set() },
  };
  const expected: Record<string, string[]> = {
    admin: [ROOT, CHILD, 'd3', 'd4'],
    member: [ROOT],
    grantee: [ROOT, CHILD, 'd3'],
    'guest granted the child': [CHILD, 'd3'],
    'guest granted nothing': [],
  };

  for (const [name, scope] of Object.entries(scopes)) {
    it(`agree for ${name}`, () => {
      const inMemory = rows.filter((r) => canSee(scope, r)).map((r) => r.id);
      const where = visibilityWhere(scope);
      const inSql = rows.filter((r) => matches(where, r)).map((r) => r.id);
      expect(inMemory).toEqual(expected[name]);
      expect(inSql).toEqual(inMemory);
    });
  }

  it('is no filter at all for a workspace with no restrictions', () => {
    expect(visibilityWhere({ ...who(), workspaceId: WS, denied: new Set(), granted: new Set() })).toEqual({});
  });
});

// ------------------------------------------------------------- the guard

const alice: Principal = {
  userId: ALICE,
  email: 'alice@x.test',
  displayName: 'Alice',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};

/** PermissionService over one restricted page (CHILD under ROOT), with Alice in the given role. */
function permissionsAs(role: string, grants: GrantRow[] = []) {
  const docs = [
    { id: ROOT, title: 'Handbook', restricted: false },
    { id: CHILD, title: 'Salaries', restricted: true },
  ];
  const prisma = {
    workspaceMember: { findUnique: vi.fn(async () => ({ role, trustedOperator: false })) },
    userGroupMember: { findMany: vi.fn(async () => []) },
    accessGrant: {
      findMany: vi.fn(async ({ where }: { where: { resourceId?: { in: string[] } } }) =>
        where.resourceId ? grants.filter((g) => where.resourceId!.in.includes(g.resourceId)) : grants,
      ),
    },
    document: {
      findMany: vi.fn(async ({ where }: { where: { restricted?: boolean; id?: { in: string[] } } }) =>
        where.restricted ? docs.filter((d) => d.restricted) : docs.filter((d) => where.id?.in.includes(d.id)),
      ),
      findUnique: vi.fn(async () => ({ workspaceId: WS, projectId: PROJECT, path: `/${ROOT}/${CHILD}/` })),
    },
    project: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => ({ workspaceId: WS, name: 'People', restricted: false })),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new PermissionService(prisma as never, new AccessService(prisma as never), audit as never);
  return { service, audit, prisma };
}

describe('PermissionService.requireResource', () => {
  const page = { type: 'document' as const, id: CHILD };

  it('answers a member a 403 that offers access and names nothing', async () => {
    const error = await permissionsAs('editor').service.requireResource(alice, WS, page, 'viewer', false).catch((e) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ canRequestAccess: true, resourceType: 'document', resourceId: CHILD });
    expect(JSON.stringify(error.getResponse())).not.toContain('Salaries');
  });

  it('answers a guest a 404: they learn nothing, not even that the page exists', async () => {
    const error = await permissionsAs('guest').service.requireResource(alice, WS, page, 'viewer', false).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('lets a guest through on a granted page, on a viewer or editor route but never an admin one', async () => {
    const { service } = permissionsAs('guest', [grant(CHILD, ALICE, 'edit')]);
    await expect(service.requireResource(alice, WS, page, 'viewer', false)).resolves.toBeUndefined();
    await expect(service.requireResource(alice, WS, page, 'editor', false)).resolves.toBeUndefined();
    await expect(service.requireResource(alice, WS, page, 'admin', false)).rejects.toThrow(/roleRequired/);
  });

  it('refuses an editor an edit route on a page whose editors are named, with the levels in the body', async () => {
    const { service } = permissionsAs('editor', [grant(CHILD, ALICE, 'view'), grant(CHILD, BOB, 'edit')]);
    await expect(service.requireResource(alice, WS, page, 'viewer', false)).resolves.toBeUndefined();
    const error = await service.requireResource(alice, WS, page, 'editor', false).catch((e) => e);
    expect(error.getResponse()).toMatchObject({ level: 'view', required: 'edit' });
  });

  it('lets a workspace admin through without a grant, and writes it down once per window', async () => {
    const { service, audit } = permissionsAs('admin');
    await service.requireResource(alice, WS, page, 'viewer', false);
    await service.requireResource(alice, WS, page, 'viewer', false);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'acl.bypass', params: { resourceType: 'document', resourceId: CHILD } }),
    );
  });

  it('does not audit an admin reading what is open to everyone', async () => {
    const { service, audit } = permissionsAs('admin');
    await service.requireResource(alice, WS, { type: 'project', id: PROJECT }, 'viewer', false);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('ResourceAccessService.update', () => {
  it('refuses a change that would leave the caller unable to manage the page', async () => {
    const { service, prisma } = permissionsAs('editor', [grant(CHILD, ALICE, 'manage')]);
    Object.assign(prisma, {
      workspaceMember: { ...prisma.workspaceMember, findMany: vi.fn(async () => [{ userId: BOB }]) },
      userGroup: { findMany: vi.fn(async () => []) },
    });
    const access = new ResourceAccessService(prisma as never, service, { record: vi.fn() } as never);
    const error = await access
      .update(alice, { type: 'document', id: CHILD }, { restricted: true, grants: [{ subjectType: 'user', subjectId: BOB, level: 'manage' }] })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ reason: 'access.selfLockout' });
  });

  it('refuses a caller without manage before reading anything else', async () => {
    const { service, prisma } = permissionsAs('viewer', [grant(CHILD, ALICE, 'view')]);
    const access = new ResourceAccessService(prisma as never, service, { record: vi.fn() } as never);
    await expect(
      access.update(alice, { type: 'document', id: CHILD }, { restricted: false, grants: [] }),
    ).rejects.toMatchObject({ response: { required: 'manage' } });
  });
});
