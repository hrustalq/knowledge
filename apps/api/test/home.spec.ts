import { HomeService } from '../src/home/home.service.js';
import { recentPages } from '../src/projects/project-overview.service.js';
import type { AccessScope } from '../src/permissions/access-scope.js';
import type { Principal } from '../src/auth/principal.js';

// The workspace home (#1243): which widgets and numbers a caller gets.

const WS = '11111111-1111-4111-8111-111111111111';

function scope(over: Partial<AccessScope>): AccessScope {
  return {
    workspaceId: WS,
    userId: 'u1',
    role: 'viewer',
    bypass: false,
    guest: false,
    readOnly: false,
    groupIds: new Set(),
    denied: new Set(),
    granted: new Set(),
    ...over,
  };
}

function build(homeWidgets: unknown, disabled: string[] = []) {
  const calls: string[] = [];
  const track = <T>(name: string, value: T) => () => (calls.push(name), Promise.resolve(value));
  const prisma = {
    workspaceSettings: { findUnique: async () => ({ homeWidgets }) },
    document: { count: track('pages', 7) },
    mergeRequest: { count: track('openMergeRequests', 2) },
    documentRevision: { findMany: track('recent', []) },
  };
  const service = new HomeService(
    prisma as never,
    { disabled: async () => disabled, unavailable: () => [] } as never,
    { list: track('activity', { entries: [] }) } as never,
    { summary: track('health', { total: 10, verified: 4, counts: { stale: 3 } }) } as never,
    { listWorkspace: track('reviews', { mergeRequests: [], counts: { open: 0 } }) } as never,
    { list: track('inbox', { entries: [], unreadCount: 0 }) } as never,
    { overview: track('analytics', { zeroResultSearches: 5 }) } as never,
    { list: track('agents', { runs: [], counts: { pending: 1 } }) } as never,
  );
  return { service, calls };
}

const principal = {} as Principal;

describe('HomeService', () => {
  it('shows the built-in layout when nothing is stored', async () => {
    const { service } = build(null);
    const home = await service.get(scope({}), principal);
    expect(home.custom).toBe(false);
    expect(home.widgets).toEqual(['metrics', 'actions', 'needs-you', 'recent', 'activity', 'agents']);
    expect(home.metrics).toMatchObject({ pages: 10, verified: 4, stale: 3, openMergeRequests: 2, unansweredSearches: null });
  });

  it('leaves out what an admin hid, and never reads it', async () => {
    const { service, calls } = build(['recent', 'metrics']);
    const home = await service.get(scope({}), principal);
    expect(home.custom).toBe(true);
    expect(home.widgets).toEqual(['recent', 'metrics']);
    expect(home.activity).toBeUndefined();
    expect(calls).not.toContain('activity');
    expect(calls).not.toContain('agents');
  });

  it('gives a guest only what their routes would: no merge requests, agents, health or analytics', async () => {
    const { service, calls } = build(null);
    const home = await service.get(scope({ role: 'guest', guest: true }), principal);
    expect(home.widgets).not.toContain('agents');
    expect(home.metrics).toMatchObject({ pages: 7, verified: null, stale: null, openMergeRequests: null });
    expect(home.needsYou?.reviews).toBeNull();
    expect(calls).not.toEqual(expect.arrayContaining(['reviews']));
    expect(calls).not.toContain('health');
    expect(calls).not.toContain('openMergeRequests');
  });

  it('counts unanswered searches for an admin only while analytics is on, and drops health when it is off', async () => {
    const admin = scope({ role: 'admin', bypass: true });
    expect((await build(null).service.get(admin, principal)).metrics?.unansweredSearches).toBe(5);
    const off = await build(null, ['analytics', 'knowledge-health']).service.get(admin, principal);
    expect(off.metrics).toMatchObject({ pages: 7, verified: null, unansweredSearches: null });
  });
});

describe('recentPages', () => {
  // #1293: a row carries the head's lifecycle and the page's verification state.
  it('stamps each newest-revised page with its head status and verification', async () => {
    const at = new Date('2026-11-19T10:00:00Z');
    const prisma = {
      documentRevision: {
        findMany: async ({ where }: { where: { id?: unknown } }) =>
          where.id
            ? [{ id: 'h1', status: 'indexing' }, { id: 'h2', status: 'failed' }]
            : [
                { documentId: 'a', createdAt: at },
                { documentId: 'b', createdAt: at },
                { documentId: 'a', createdAt: new Date('2026-11-01T00:00:00Z') },
              ],
      },
      document: {
        findMany: async () => [
          { id: 'b', title: 'B', defaultBranch: 'main', verificationFlag: 'outdated', verifiedRevisionId: null, verificationExpiresAt: null, branches: [{ name: 'main', headRevisionId: 'h2' }] },
          { id: 'a', title: 'A', defaultBranch: 'main', verificationFlag: null, verifiedRevisionId: 'h1', verificationExpiresAt: null, branches: [{ name: 'main', headRevisionId: 'h1' }] },
        ],
      },
      knowledgeIssue: { groupBy: async () => [] },
      connectorLink: { findMany: async () => [] },
    };
    expect(await recentPages(prisma as never, {})).toEqual([
      { documentId: 'a', title: 'A', updatedAt: at.toISOString(), headRevisionStatus: 'indexing', verification: 'verified' },
      { documentId: 'b', title: 'B', updatedAt: at.toISOString(), headRevisionStatus: 'failed', verification: 'outdated' },
    ]);
  });
});
