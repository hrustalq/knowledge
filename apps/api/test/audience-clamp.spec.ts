import { describe, expect, it, vi } from 'vitest';
import {
  canSee,
  clampToAudience,
  OPEN_TO_WORKSPACE,
  visibilityWhere,
  type AccessScope,
} from '../src/permissions/access-scope.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { matchesWhere, type WhereRow } from './prisma-where.js';

/**
 * The audience clamp (issue #76, phase 4).
 *
 * A run whose output is read by more people than its owner — a reply in a
 * thread on page P, an agent's findings listed to the workspace, a bot answer
 * in a group — may only draw on a page D when `D.restricted_by ⊆
 * P.restricted_by`. Everyone who can read P then passes every restricted node
 * on D's chain, so nothing reaches a reader through the run that they could not
 * have opened themselves.
 *
 * What is pinned:
 * 1. **The subset rule, exhaustively** over every combination of three
 *    restricted nodes on the destination and on the source — in memory and as
 *    the Prisma filter, which must agree.
 * 2. **The owner still narrows it.** The clamp intersects; it never shows the
 *    owner a page their own grants hide.
 * 3. **Admins are clamped too.** An admin owner bypasses for themselves, not
 *    for the people reading what their run wrote.
 * 4. **The workspace audience** is exactly "nothing restricted on the chain".
 * 5. **An unknown destination clamps to the narrowest audience**, never the
 *    widest.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NODES = ['n1000000-0000-4000-8000-000000000001', 'n2000000-0000-4000-8000-000000000002', 'n3000000-0000-4000-8000-000000000003'];

function scope(over: Partial<AccessScope> = {}): AccessScope {
  return {
    workspaceId: WS,
    userId: '44444444-4444-4444-8444-444444444444',
    role: 'editor',
    bypass: false,
    guest: false,
    readOnly: false,
    groupIds: new Set(),
    denied: new Set(),
    granted: new Set(NODES),
    ...over,
  };
}

/** Every subset of NODES, in chain order. */
const subsets = (): string[][] => [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => NODES.filter((_, i) => mask & (1 << i)));

const row = (restrictedBy: string[], id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'): WhereRow => ({
  id,
  workspaceId: WS,
  projectId: PROJECT,
  path: `/${id}/`,
  restrictedBy,
});

describe('clampToAudience', () => {
  it('admits D exactly when D.restricted_by ⊆ P.restricted_by, in memory and in Prisma', () => {
    for (const audience of subsets()) {
      const clamped = clampToAudience(scope(), NODES, new Set(audience));
      for (const source of subsets()) {
        const expected = source.every((id) => audience.includes(id));
        const d = row(source);
        expect(canSee(clamped, d), `P=${audience.length} D=${source.length}`).toBe(expected);
        expect(matchesWhere(visibilityWhere(clamped), d)).toBe(expected);
      }
    }
  });

  it('never shows the owner what their own grants hide', () => {
    const owner = scope({ denied: new Set([NODES[0]!]), granted: new Set(NODES.slice(1)) });
    const clamped = clampToAudience(owner, NODES, new Set(NODES));
    expect(canSee(clamped, row([NODES[0]!]))).toBe(false);
    expect(canSee(clamped, row([NODES[1]!]))).toBe(true);
    expect(canSee(clamped, row([]))).toBe(true);
  });

  it('clamps an admin owner like anyone: their bypass is theirs, not their readers’', () => {
    const admin = scope({ role: 'admin', bypass: true, granted: new Set(), denied: new Set(NODES) });
    const clamped = clampToAudience(admin, NODES, new Set([NODES[0]!]));
    expect(clamped.bypass).toBe(false);
    expect(canSee(clamped, row([NODES[0]!]))).toBe(true);
    expect(canSee(clamped, row([NODES[0]!, NODES[1]!]))).toBe(false);
  });

  it('with the workspace audience, keeps exactly the pages nothing restricts', () => {
    const clamped = clampToAudience(scope(), NODES, new Set());
    for (const source of subsets()) {
      const d = row(source);
      expect(canSee(clamped, d)).toBe(source.length === 0);
      expect(matchesWhere(OPEN_TO_WORKSPACE, d)).toBe(source.length === 0);
    }
  });

  it('changes nothing in a workspace with no restrictions', () => {
    const clamped = clampToAudience(scope({ granted: new Set() }), [], new Set());
    expect(visibilityWhere(clamped)).toEqual({});
  });
});

describe('PermissionService.audienceScope', () => {
  function service(destination: { workspaceId: string; restrictedBy: string[] } | null) {
    const prisma = {
      document: {
        findMany: vi.fn(async () => [{ id: NODES[1]! }, { id: NODES[2]! }]),
        findUnique: vi.fn(async () => destination),
      },
      project: { findMany: vi.fn(async () => [{ id: NODES[0]! }]) },
    };
    return new PermissionService(prisma as never, {} as never, {} as never, {} as never);
  }

  it('clamps to the destination page’s own restrictions', async () => {
    const clamped = await service({ workspaceId: WS, restrictedBy: [NODES[0]!] }).audienceScope(scope(), {
      kind: 'document',
      documentId: DEST,
    });
    expect(canSee(clamped, row([NODES[0]!]))).toBe(true);
    expect(canSee(clamped, row([NODES[0]!, NODES[1]!]))).toBe(false);
  });

  it('falls back to the workspace audience for a destination that is gone or elsewhere', async () => {
    for (const destination of [null, { workspaceId: OTHER_WS, restrictedBy: NODES }]) {
      const clamped = await service(destination).audienceScope(scope(), { kind: 'document', documentId: DEST });
      expect(canSee(clamped, row([NODES[0]!]))).toBe(false);
      expect(canSee(clamped, row([]))).toBe(true);
    }
  });
});
