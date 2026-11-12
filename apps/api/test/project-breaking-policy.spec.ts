import { describe, expect, it, vi } from 'vitest';
import { scopedApiBreakingChangePolicy } from '@knowledge/contracts';
import { ApiSpecDiffService } from '../src/api-specs/api-spec-diff.service.js';
import { ApiSettingsService } from '../src/api-specs/api-settings.service.js';

/** The breaking-API merge gate per project (#922): project → workspace → warn. */

const WS = '11111111-1111-4111-8111-111111111111';
const PUBLIC_API = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SANDBOX = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function prismaOver(workspace: string | null, projects: Record<string, string | null>) {
  const row = (id: string) => (id in projects ? { workspaceId: WS, apiBreakingChangePolicy: projects[id] } : null);
  return {
    workspaceSettings: { findUnique: vi.fn(async () => (workspace ? { apiBreakingChangePolicy: workspace } : null)) },
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) => (where.workspaceId === WS ? row(where.id) : null)),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => row(where.id)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { apiBreakingChangePolicy: string | null } }) => {
        projects[where.id] = data.apiBreakingChangePolicy;
      }),
    },
  };
}

describe('the breaking-change policy across levels', () => {
  it('resolves project → workspace → warn, and ignores a value outside the vocabulary', () => {
    expect(scopedApiBreakingChangePolicy(null, null)).toEqual({ workspace: null, project: null, effective: 'warn', source: 'default' });
    expect(scopedApiBreakingChangePolicy(null, 'block')).toMatchObject({ effective: 'block', source: 'workspace' });
    expect(scopedApiBreakingChangePolicy('off', 'block')).toMatchObject({ effective: 'off', source: 'project' });
    expect(scopedApiBreakingChangePolicy('strict', 'block')).toMatchObject({ project: null, effective: 'block', source: 'workspace' });
  });

  it('holds a merge only in the project that says block, under a workspace that warns', async () => {
    const diffs = new ApiSpecDiffService(prismaOver('warn', { [PUBLIC_API]: 'block', [SANDBOX]: null }) as never, {} as never, {} as never);
    expect(await diffs.breakingPolicy(WS, PUBLIC_API)).toBe('block');
    expect(await diffs.breakingPolicy(WS, SANDBOX)).toBe('warn');
    // No project values at all: the workspace's answer, as before #922.
    expect(await new ApiSpecDiffService(prismaOver(null, {}) as never, {} as never, {} as never).breakingPolicy(WS, SANDBOX)).toBe('warn');
  });

  it("never borrows another workspace's project", async () => {
    const diffs = new ApiSpecDiffService(prismaOver('warn', { [PUBLIC_API]: 'block' }) as never, {} as never, {} as never);
    expect(await diffs.breakingPolicy('22222222-2222-4222-8222-222222222222', PUBLIC_API)).toBe('warn');
  });

  it('reports each level and goes back to inheriting on null', async () => {
    const prisma = prismaOver('warn', { [PUBLIC_API]: null });
    const settings = new ApiSettingsService(prisma as never, { get: () => 'off' } as never, {} as never);
    expect((await settings.setProjectBreakingChanges(PUBLIC_API, 'block')).policy).toEqual({ workspace: 'warn', project: 'block', effective: 'block', source: 'project' });
    expect((await settings.setProjectBreakingChanges(PUBLIC_API, null)).policy).toEqual({ workspace: 'warn', project: null, effective: 'warn', source: 'workspace' });
  });
});
