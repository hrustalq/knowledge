import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeEvent } from '@knowledge/contracts';
import { LiveVisibility } from '../src/events/live-visibility.js';
import { ActivityService } from '../src/activity/activity.service.js';
import type { AccessScope } from '../src/permissions/access-scope.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Live frames and the activity feed under page restrictions (issue #76, phase 5).
 *
 * What is pinned:
 * 1. **A frame about a page reaches only those who can open it**; workspace
 *    frames and frames addressed to one person pass untouched.
 * 2. **Scopes are cached per connection and dropped on `acl.changed`**, so a
 *    grant takes effect on the next frame rather than after the TTL.
 * 3. **The activity feed filters in SQL**, with a `(created_at, id)` cursor, so
 *    pages are never short and cursors stay stable.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const SECRET = '33333333-3333-4333-8333-333333333333';
const OPEN = '44444444-4444-4444-8444-444444444444';
const ALICE = '55555555-5555-4555-8555-555555555555';
const BOB = '66666666-6666-4666-8666-666666666666';

const p = (userId: string): Principal => ({
  userId,
  email: null,
  displayName: userId,
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
});

const scope = (userId: string, denied: string[]): AccessScope => ({
  workspaceId: WS,
  userId,
  role: 'viewer',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  denied: new Set(denied),
  granted: new Set(),
});

function visibility(scopes: Record<string, AccessScope>) {
  const permissions = { scopeFor: vi.fn(async (principal: Principal) => scopes[principal.userId]) };
  const prisma = {
    document: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        workspaceId: WS,
        projectId: PROJECT,
        path: `/${where.id}/`,
        restrictedBy: where.id === SECRET ? [SECRET] : [],
      })),
    },
  };
  const config = { get: () => 60_000 };
  return { live: new LiveVisibility(config as never, prisma as never, permissions as never), permissions, prisma };
}

const frame = (over: Partial<KnowledgeEvent>): KnowledgeEvent => ({
  type: 'document.updated',
  workspaceId: WS,
  at: new Date().toISOString(),
  ...over,
});

describe('LiveVisibility', () => {
  it('drops a frame about a restricted page for whoever cannot open it', async () => {
    const { live } = visibility({ [ALICE]: scope(ALICE, []), [BOB]: scope(BOB, [SECRET]) });
    expect(await live.allows(frame({ documentId: SECRET }), [p(ALICE), p(BOB)])).toEqual([true, false]);
    expect(await live.allows(frame({ documentId: OPEN }), [p(ALICE), p(BOB)])).toEqual([true, true]);
  });

  it('never reads a page for listeners nothing is hidden from', async () => {
    const { live, prisma } = visibility({ [ALICE]: scope(ALICE, []) });
    expect(await live.allows(frame({ documentId: SECRET }), [p(ALICE)])).toEqual([true]);
    expect(prisma.document.findUnique).not.toHaveBeenCalled();
  });

  it('passes workspace frames and addressed frames without asking', async () => {
    const { live, permissions } = visibility({ [BOB]: scope(BOB, [SECRET]) });
    expect(await live.allows(frame({ type: 'acl.changed' }), [p(BOB)])).toEqual([true]);
    expect(await live.allows(frame({ type: 'notification.created', userId: BOB, documentId: SECRET }), [p(BOB)])).toEqual([true]);
    expect(permissions.scopeFor).not.toHaveBeenCalled();
  });

  it('caches a connection’s scope and forgets it on acl.changed', async () => {
    const scopes = { [BOB]: scope(BOB, [SECRET]) };
    const { live, permissions } = visibility(scopes);
    expect(await live.allows(frame({ documentId: SECRET }), [p(BOB)])).toEqual([false]);
    scopes[BOB] = scope(BOB, []); // granted a moment later
    expect(await live.allows(frame({ documentId: SECRET }), [p(BOB)])).toEqual([false]); // still cached
    live.observe(frame({ type: 'acl.changed' }));
    expect(await live.allows(frame({ documentId: SECRET }), [p(BOB)])).toEqual([true]);
    expect(permissions.scopeFor).toHaveBeenCalledTimes(2);
  });

  it('delivers nothing about pages when the scope cannot be computed', async () => {
    const { live, permissions } = visibility({});
    permissions.scopeFor.mockRejectedValueOnce(new Error('not a member'));
    expect(await live.allows(frame({ documentId: OPEN }), [p(BOB)])).toEqual([false]);
  });
});

describe('ActivityService.list visibility', () => {
  it('filters rows about hidden pages in SQL and pages by (created_at, id)', async () => {
    const queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw: queryRaw, activityLog: { findMany: vi.fn(async () => []) }, document: { findMany: vi.fn() } };
    const service = new ActivityService(prisma as never, {} as never);
    await service.list(WS, { limit: 10, cursor: OPEN }, scope(BOB, [SECRET]));
    const sql = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const text = JSON.stringify(sql);
    expect(text).toContain('NOT EXISTS');
    expect(text).toContain('restricted_by');
    expect(text).toContain('(a.\\"created_at\\", a.\\"id\\") <');
  });

  it('runs no visibility predicate for a caller nothing is hidden from', async () => {
    const queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw: queryRaw, activityLog: { findMany: vi.fn(async () => []) }, document: { findMany: vi.fn() } };
    await new ActivityService(prisma as never, {} as never).list(WS, {}, scope(ALICE, []));
    expect(JSON.stringify(queryRaw.mock.calls[0])).not.toContain('EXISTS');
  });

  it('keeps a guest to rows about pages they can open', async () => {
    const queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw: queryRaw, activityLog: { findMany: vi.fn(async () => []) }, document: { findMany: vi.fn() } };
    const guest = { ...scope(BOB, []), role: 'guest' as const, guest: true, granted: new Set([OPEN]) };
    await new ActivityService(prisma as never, {} as never).list(WS, {}, guest);
    const text = JSON.stringify(queryRaw.mock.calls[0]);
    expect(text).toContain('EXISTS');
    expect(text).not.toContain('NOT EXISTS');
  });
});
