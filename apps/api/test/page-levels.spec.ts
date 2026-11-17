import { describe, expect, it, vi } from 'vitest';
import { levelOf, type BlueprintLevel } from '@knowledge/contracts';
import { pageLevel, projectLevels } from '../src/projects/methodology-scope.js';
import { levelBoost, rankPool, type SearchKnobs, type SearchPool } from '../src/search/ranking.js';
import { ProjectMethodologyService } from '../src/projects/project-methodology.service.js';

const LEVELS: BlueprintLevel[] = [
  { key: 'intent', name: { en: 'Intent', ru: 'Замысел' }, templateRefs: ['builtin:intent'] },
  { key: 'rules', name: { en: 'Rules' }, templateRefs: ['builtin:rule', 'builtin:adr'], agentKey: 'reviewer', description: { en: 'One invariant a page' } },
];

describe('levelOf (#1126)', () => {
  it('reads a page’s level off its template, first level first; none without a template or a level for it', () => {
    expect(levelOf('builtin:adr', LEVELS)?.key).toBe('rules');
    expect(levelOf('builtin:rfc', LEVELS)).toBeNull();
    expect(levelOf(null, LEVELS)).toBeNull();
    expect(levelOf('builtin:adr', undefined)).toBeNull();
    expect(pageLevel('builtin:intent', LEVELS, 'ru')).toEqual({ key: 'intent', name: 'Замысел' });
  });

  it('resolves each project’s levels through its methodology, live; a project without one has none', async () => {
    const projects = [
      { id: 'p1', blueprintId: 'b1' },
      { id: 'p2', blueprintId: 'b2' },
    ];
    const prisma = {
      project: { findMany: vi.fn(async () => projects) },
      projectBlueprint: {
        findMany: vi.fn(async () => [
          { id: 'b1', builtInKey: null, versions: [{ blueprint: { name: { en: 'M' }, tree: [], levels: LEVELS } }] },
          // An override serving the code: no version of its own, a built-in with no levels.
          { id: 'b2', builtInKey: 'blank', versions: [] },
        ]),
      },
    };
    const levels = await projectLevels(prisma as never, ['p1', 'p2', 'p3', 'p1']);
    expect([...levels.keys()]).toEqual(['p1']);
    expect(levels.get('p1')).toBe(LEVELS);
    // Switching is one column: the next read follows it, the page untouched.
    projects[0]!.blueprintId = 'b2';
    expect((await projectLevels(prisma as never, ['p1'])).size).toBe(0);
    expect((await projectLevels(prisma as never, [])).size).toBe(0);
  });
});

describe('level prior (#1126)', () => {
  const knobs: SearchKnobs = {
    rrfK: 60,
    minCosine: 0,
    minCosineShare: 0,
    communityPriorWeight: 0,
    communityPriorFloor: 0.5,
    trustWeights: { verified: 1, expired: 1, flagged: 1, outdated: 1, inactive: 1, unverified: 1, requested: 1, edited: 1 } as never,
  };
  const hit = (documentId: string, score: number) => ({ chunkId: `c-${documentId}`, documentId, revisionId: 'r', score, text: 'x', headingPath: [] }) as never;
  const page = { status: 'unverified' as const, inactive: false, archived: false };
  const pool: SearchPool = {
    query: 'billing rules',
    vectorHits: [hit('a', 0.9), hit('b', 0.85), hit('c', 0.8)],
    textHits: [],
    fetchK: 10,
    k: 10,
    trustOn: false,
    pages: new Map([['a', page], ['b', page], ['c', page]]),
    communities: [],
  };

  it('ranks exactly as before when no level is asked, levels known or not', () => {
    const before = rankPool(pool, knobs);
    expect(rankPool({ ...pool, levels: new Map([['c', 'rules']]) }, knobs)).toEqual(before);
    expect(levelBoost('rules', undefined)).toBe(1);
  });

  it('boosts pages at the asked level and keeps every other page', () => {
    const ranked = rankPool({ ...pool, level: 'rules', levels: new Map([['c', 'rules']]) }, knobs);
    expect(ranked[0]).toBe('c');
    expect([...ranked].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('GET /v1/projects/:id/levels (#1126)', () => {
  it('lists the levels in order with the pages the caller can see at each, or none', async () => {
    const linked = { blueprintId: 'b1' as string | null };
    const prisma = {
      project: {
        findUnique: vi.fn(async () => ({ workspaceId: 'ws' })),
        findMany: vi.fn(async () => (linked.blueprintId ? [{ id: 'p', blueprintId: linked.blueprintId }] : [])),
      },
      projectBlueprint: { findMany: vi.fn(async () => [{ id: 'b1', builtInKey: null, versions: [{ blueprint: { levels: LEVELS } }] }]) },
      document: { groupBy: vi.fn(async () => [{ templateRef: 'builtin:adr', _count: { _all: 2 } }, { templateRef: 'builtin:rule', _count: { _all: 1 } }]) },
    };
    const permissions = { scopeFor: vi.fn(async () => ({ bypass: true })) };
    const service = new ProjectMethodologyService(prisma as never, {} as never, {} as never, {} as never, permissions as never);
    expect(await service.levels('p', { userId: 'u' } as never, 'en')).toEqual({
      projectId: 'p',
      levels: [
        { key: 'intent', name: 'Intent', description: null, agentKey: null, pages: 0 },
        { key: 'rules', name: 'Rules', description: 'One invariant a page', agentKey: 'reviewer', pages: 3 },
      ],
    });
    linked.blueprintId = null;
    expect((await service.levels('p', { userId: 'u' } as never)).levels).toEqual([]);
  });
});
