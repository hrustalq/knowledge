import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProfilesService } from '../src/profiles/profiles.service.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';
import type { Principal } from '../src/auth/principal.js';
import { systemScope } from '../src/permissions/access-scope.js';

/**
 * #1091: one tenant must not read another tenant's people. A profile is
 * readable only by someone who shares a workspace with its subject, and the
 * account flags (platform admin, password, API key) only by the subject and a
 * platform admin. The add-member picker of a workspace admin takes an exact
 * address, never a fragment that pages through every account.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0001';
const READER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0002';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0003';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    userId: READER,
    email: 'reader@example.test',
    displayName: 'Reader',
    avatarUrl: null,
    mode: 'api-key',
    isAdmin: false,
    locale: 'en',
    ...over,
  } as Principal;
}

const subjectRow = {
  id: SUBJECT,
  email: 'subject@other.test',
  displayName: 'Subject',
  avatarKey: null,
  isAdmin: true,
  disabledAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  passwordHash: 'scrypt$x',
  apiKeys: [{ id: 'k1' }],
};

function profiles(opts: { shared: boolean }) {
  const prisma = {
    user: { findUnique: vi.fn(async () => subjectRow) },
    workspaceMember: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => (opts.shared ? { workspaceId: WS } : null)),
    },
    documentRevision: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => [{ count: 0n }]),
    mergeRequest: { count: vi.fn(async () => 0) },
    reviewThread: { count: vi.fn(async () => 0) },
    revisionComment: { count: vi.fn(async () => 0) },
  };
  const permissions = { scopeFor: vi.fn(async () => systemScope(WS)) };
  const svc = new ProfilesService(prisma as never, permissions as never);
  // The open-work and page counts are not what this spec is about.
  vi.spyOn(svc as never, 'pageCountFor').mockResolvedValue(0 as never);
  vi.spyOn(svc as never, 'openWorkFor').mockResolvedValue({ openMergeRequests: 0, pendingReviews: 0, openThreads: 0 } as never);
  return { svc, prisma };
}

describe('profiles (#1091): readable only across a shared workspace', () => {
  it('404s a profile of someone the reader shares no workspace with', async () => {
    const { svc } = profiles({ shared: false });
    await expect(svc.get(principal(), WS, SUBJECT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('hides the account flags from a colleague who is not a platform admin', async () => {
    const { svc } = profiles({ shared: true });
    const p = await svc.get(principal(), WS, SUBJECT);
    expect(p.email).toBe('subject@other.test');
    expect(p.isAdmin).toBeNull();
    expect(p.hasPassword).toBeNull();
    expect(p.hasApiKey).toBeNull();
  });

  it('shows the account flags to the subject and to a platform admin', async () => {
    const self = await profiles({ shared: false }).svc.get(principal({ userId: SUBJECT }), WS, SUBJECT);
    expect([self.isAdmin, self.hasPassword, self.hasApiKey]).toEqual([true, true, true]);
    const admin = await profiles({ shared: false }).svc.get(principal({ isAdmin: true }), WS, SUBJECT);
    expect([admin.isAdmin, admin.hasPassword, admin.hasApiKey]).toEqual([true, true, true]);
  });
});

function workspaces(signup = true) {
  const prisma = {
    workspaceMember: { findMany: vi.fn(async () => []), create: vi.fn() },
    user: {
      findMany: vi.fn(async () => [subjectRow]),
      findUnique: vi.fn(async ({ where }: { where: { email?: string } }) => (where.email === 'subject@other.test' ? subjectRow : null)),
    },
    workspace: { create: vi.fn(async () => ({ id: WS, name: 'w' })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const config = { get: vi.fn((k: string) => (k === 'AUTH_SIGNUP_ENABLED' ? signup : undefined)) };
  const svc = new WorkspacesService(prisma as never, {} as never, {} as never, {} as never, config as never);
  return { svc, prisma };
}

describe('add-member picker (#1091): an exact address, never a fragment', () => {
  it('answers a workspace admin nothing for a fragment, and searches no account table', async () => {
    const { svc, prisma } = workspaces();
    const res = await svc.listCandidates(principal(), WS, 'subj', 20);
    expect(res.candidates).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('finds the one account a full address names', async () => {
    const { svc } = workspaces();
    const res = await svc.listCandidates(principal(), WS, '  Subject@Other.test ', 20);
    expect(res.candidates.map((c) => c.userId)).toEqual([SUBJECT]);
  });

  it('still lets a platform admin search by fragment', async () => {
    const { svc, prisma } = workspaces();
    const res = await svc.listCandidates(principal({ isAdmin: true }), WS, 'subj', 20);
    expect(res.candidates.map((c) => c.userId)).toEqual([SUBJECT]);
    expect(prisma.user.findMany).toHaveBeenCalled();
  });
});

describe('workspace creation (#1091): closed with signup', () => {
  it('refuses a non-admin when signup is off', async () => {
    const { svc, prisma } = workspaces(false);
    await expect(svc.create(principal(), 'mine')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspace.create).not.toHaveBeenCalled();
  });

  it('lets a platform admin, and anyone while signup is on, create one', async () => {
    await expect(workspaces(false).svc.create(principal({ isAdmin: true }), 'w')).resolves.toMatchObject({ workspaceId: WS });
    await expect(workspaces(true).svc.create(principal(), 'w')).resolves.toMatchObject({ workspaceId: WS });
  });
});
