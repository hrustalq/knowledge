import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessRequestsService, grantTargets } from '../src/permissions/access-requests.service.js';
import type { AccessIdentity, AccessScope, ChainNode, GrantRow } from '../src/permissions/access-scope.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Access requests (issue #76, phase 5).
 *
 * What is pinned:
 * 1. **Approving opens what kept the requester out.** View is intersective, so
 *    the grant goes on every restricted node they lacked one on — a grant on
 *    the page alone, under a closed parent, would admit no one.
 * 2. **Asking is no way to learn a page exists**: a guest who cannot open it
 *    gets the 404 the guard would give, and a denial carries no title.
 * 3. **One pending request per person and node** (409, from the partial
 *    unique index), and a decided request cannot be decided again.
 * 4. **Expiry is guarded per row**, so a request decided a moment ago is not
 *    reported expired.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';
const PAGE = '44444444-4444-4444-8444-444444444444';
const ALICE = '55555555-5555-4555-8555-555555555555'; // requester
const BOB = '66666666-6666-4666-8666-666666666666'; // manager
const REQ = '77777777-7777-4777-8777-777777777777';

const who = (over: Partial<AccessIdentity> = {}): AccessIdentity => ({
  userId: ALICE,
  role: 'viewer',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  ...over,
});

const node = (id: string, restricted: boolean, type: 'project' | 'document' = 'document'): ChainNode & { title: string } => ({
  type,
  id,
  restricted,
  title: id === PAGE ? 'Payroll' : id === PARENT ? 'HR' : 'Ops',
});

describe('grantTargets', () => {
  it('names every restricted node the requester holds no grant on', () => {
    const chain = [node(PROJECT, false, 'project'), node(PARENT, true), node(PAGE, true)];
    const grants: GrantRow[] = [{ resourceId: PAGE, subjectType: 'user', subjectId: ALICE, level: 'view' }];
    expect(grantTargets(chain, grants, who()).map((n) => n.id)).toEqual([PARENT]);
  });

  it('counts a grant held through a group', () => {
    const chain = [node(PROJECT, true, 'project'), node(PAGE, true)];
    const grants: GrantRow[] = [{ resourceId: PROJECT, subjectType: 'group', subjectId: 'g', level: 'view' }];
    expect(grantTargets(chain, grants, who({ groupIds: new Set(['g']) })).map((n) => n.id)).toEqual([PAGE]);
  });

  it('falls back to the nearest restricted node when nothing keeps them out (asking to edit)', () => {
    const chain = [node(PROJECT, false, 'project'), node(PARENT, true), node(PAGE, false)];
    const grants: GrantRow[] = [{ resourceId: PARENT, subjectType: 'user', subjectId: ALICE, level: 'view' }];
    expect(grantTargets(chain, grants, who()).map((n) => n.id)).toEqual([PARENT]);
  });

  it('grants on the node itself when nothing on the chain is restricted', () => {
    const chain = [node(PROJECT, false, 'project'), node(PAGE, false)];
    expect(grantTargets(chain, [], who({ role: 'guest', guest: true })).map((n) => n.id)).toEqual([PAGE]);
  });
});

const principal = (userId: string): Principal => ({
  userId,
  email: `${userId}@x.test`,
  displayName: userId,
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
});

const scope = (userId: string, over: Partial<AccessScope> = {}): AccessScope => ({
  workspaceId: WS,
  userId,
  role: 'viewer',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  denied: new Set([PARENT]),
  granted: new Set(),
  ...over,
});

const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: REQ,
  workspaceId: WS,
  resourceType: 'document',
  resourceId: PAGE,
  requesterId: ALICE,
  level: 'view',
  message: null,
  status: 'pending',
  decidedBy: null,
  decidedLevel: null,
  decidedAt: null,
  reason: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...over,
});

/** PAGE sits under PARENT; PARENT is restricted, and BOB manages it. */
function harness(opts: { requesterRole?: string; scopes?: Record<string, AccessScope> } = {}) {
  const chain = [node(PROJECT, false, 'project'), node(PARENT, true), node(PAGE, false)];
  const grants: GrantRow[] = [{ resourceId: PARENT, subjectType: 'user', subjectId: BOB, level: 'manage' }];
  const scopes = opts.scopes ?? { [ALICE]: scope(ALICE), [BOB]: scope(BOB, { denied: new Set(), role: 'editor' }) };
  const prisma = {
    accessRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => pendingRow(data)),
      findUnique: vi.fn(async () => pendingRow()),
      findUniqueOrThrow: vi.fn(async () => pendingRow({ status: 'approved' })),
      findMany: vi.fn(async () => [pendingRow()]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    accessGrant: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    workspaceMember: {
      findUnique: vi.fn(async () => ({ role: opts.requesterRole ?? 'viewer', user: { isAdmin: false } })),
      findMany: vi.fn(async () => []),
    },
    userGroupMember: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
  const permissions = {
    resolveChain: vi.fn(async () => ({ workspaceId: WS, chain, grants })),
    scopeFor: vi.fn(async (p: Principal) => scopes[p.userId]),
    requireLevel: vi.fn(async () => 'manage'),
  };
  const aclEvents = { notify: vi.fn(async () => undefined), changed: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { get: vi.fn(() => 30) };
  const service = new AccessRequestsService(
    prisma as never,
    permissions as never,
    aclEvents as never,
    audit as never,
    config as never,
  );
  return { service, prisma, permissions, aclEvents };
}

describe('AccessRequestsService.create', () => {
  it('files the request and tells the managers, with the title they can read', async () => {
    const h = harness();
    const entry = await h.service.create(principal(ALICE), {
      workspaceId: WS,
      resourceType: 'document',
      resourceId: PAGE,
      level: 'view',
      message: '  need the Q3 numbers ',
    });
    expect(entry.status).toBe('pending');
    expect(h.prisma.accessRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ requesterId: ALICE, level: 'view', message: 'need the Q3 numbers' }),
    });
    expect(h.aclEvents.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'access.requested', reason: 'manager', userIds: [BOB], title: 'Payroll' }),
    );
    // The requester cannot open it, so their copy of the entry is nameless.
    expect(entry.resourceTitle).toBeNull();
  });

  it('answers a duplicate pending request with 409 requestDuplicate', async () => {
    const h = harness();
    h.prisma.accessRequest.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'x' }),
    );
    const err = await h.service
      .create(principal(ALICE), { workspaceId: WS, resourceType: 'document', resourceId: PAGE, level: 'view' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ reason: 'access.requestDuplicate' });
  });

  it('gives a guest who cannot open the page the guard’s 404, not a way to probe it', async () => {
    const h = harness({ scopes: { [ALICE]: scope(ALICE, { role: 'guest', guest: true }) } });
    await expect(
      h.service.create(principal(ALICE), { workspaceId: WS, resourceType: 'document', resourceId: PAGE, level: 'view' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.prisma.accessRequest.create).not.toHaveBeenCalled();
  });

  it('refuses edit to a viewer: the workspace role stays the ceiling', async () => {
    const h = harness();
    const err = await h.service
      .create(principal(ALICE), { workspaceId: WS, resourceType: 'document', resourceId: PAGE, level: 'edit' })
      .catch((e) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ reason: 'access.levelAboveRole' });
  });

  it('refuses a node in another workspace than the one named', async () => {
    const h = harness();
    h.permissions.resolveChain.mockResolvedValueOnce({ workspaceId: 'other', chain: [], grants: [] } as never);
    await expect(
      h.service.create(principal(ALICE), { workspaceId: WS, resourceType: 'document', resourceId: PAGE, level: 'view' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AccessRequestsService decisions', () => {
  it('approving grants on the restricted parent, announces acl.changed and tells the requester', async () => {
    const h = harness();
    await h.service.approve(principal(BOB), REQ);
    expect(h.permissions.requireLevel).toHaveBeenCalledWith(expect.anything(), { ...node(PARENT, true) }, 'manage');
    expect(h.prisma.accessGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ resourceId: PARENT, subjectType: 'user', subjectId: ALICE, level: 'view' }),
    });
    expect(h.aclEvents.changed).toHaveBeenCalledWith(WS, BOB);
    expect(h.aclEvents.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'access.approved', userIds: [ALICE], title: 'Payroll' }),
    );
  });

  it('never lowers an existing grant', async () => {
    const h = harness();
    h.prisma.accessGrant.findUnique.mockResolvedValueOnce({ id: 'g1', level: 'edit' } as never);
    await h.service.approve(principal(BOB), REQ, 'view');
    expect(h.prisma.accessGrant.create).not.toHaveBeenCalled();
    expect(h.prisma.accessGrant.update).not.toHaveBeenCalled();
  });

  it('a request decided under a manager’s feet is a 409 and grants nothing', async () => {
    const h = harness();
    h.prisma.accessRequest.updateMany.mockResolvedValueOnce({ count: 0 });
    const err = await h.service.approve(principal(BOB), REQ).catch((e) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ reason: 'access.requestNotPending' });
    expect(h.prisma.accessGrant.create).not.toHaveBeenCalled();
  });

  it('denying tells the requester without naming the page', async () => {
    const h = harness();
    await h.service.deny(principal(BOB), REQ, 'ask HR directly');
    expect(h.aclEvents.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'access.denied',
        userIds: [ALICE],
        title: null,
        requireAccess: false,
        metadata: expect.objectContaining({ reason: 'ask HR directly' }),
      }),
    );
  });

  it('only the requester may withdraw', async () => {
    const h = harness();
    const err = await h.service.cancel(principal(BOB), REQ).catch((e) => e);
    expect((err as ConflictException).getResponse()).toMatchObject({ reason: 'access.requestOwnOnly' });
  });
});

describe('AccessRequestsService.expireDue', () => {
  it('expires only rows still pending when it gets to them', async () => {
    const h = harness();
    h.prisma.accessRequest.findMany.mockResolvedValueOnce([pendingRow(), pendingRow({ id: 'r2' })] as never);
    h.prisma.accessRequest.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await h.service.expireDue(new Date('2026-11-15T00:00:00Z'))).toBe(1);
    expect(h.aclEvents.notify).toHaveBeenCalledTimes(1);
    expect(h.aclEvents.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.expired', title: null }));
    expect(h.prisma.accessRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'pending', createdAt: { lt: new Date('2026-10-16T00:00:00Z') } } }),
    );
  });
});
