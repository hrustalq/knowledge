import { describe, expect, it, vi } from 'vitest';
import { ProjectCascadeService } from '../src/projects/project-cascade.service.js';
import { ProjectsService } from '../src/projects/projects.service.js';

/**
 * #901: a deleted project's memos moved nowhere and no screen listed them.
 * They now count as holdings, move on a move, and are destroyed with their
 * audio on a cascade; the memo settings naming the project follow or go null.
 */
const WS = 'ws-1';

/** A Prisma stand-in: every delegate call is recorded, counts come from `memos`. */
function fakePrisma(memos: Array<{ projectId: string; audioKey: string }>) {
  const calls: Array<[string, string, unknown]> = [];
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_o, op: string) =>
          vi.fn(async (args: { where?: { projectId?: string; id?: string } } = {}) => {
            calls.push([model, op, args]);
            const mine = memos.filter((m) => m.projectId === args.where?.projectId);
            if (model === 'project' && op === 'findUnique') return { id: args.where?.id, workspaceId: WS, name: 'Old' };
            if (model === 'project' && op === 'count') return 1;
            if (model === 'memo' && op === 'count') return mine.length;
            if (model === 'memo' && op === 'findMany') return mine;
            if (op === 'count') return 0;
            if (op === 'findMany') return [];
            return { count: 0 };
          }),
      },
    );
  const prisma: Record<string, unknown> = new Proxy(
    {
      $executeRaw: async () => 1,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    } as Record<string, unknown>,
    { get: (o, k: string) => (k in o ? o[k] : (o[k] = delegate(k))) },
  );
  const made = (model: string, op: string) => calls.filter(([m, o]) => m === model && o === op).map(([, , a]) => a);
  return { prisma, made };
}

const service = (prisma: unknown) => {
  const projects = new ProjectsService(
    prisma as never,
    { record: async () => undefined } as never,
    { recomputeRestrictedBy: async () => undefined } as never,
    { rehomeBranches: async () => undefined } as never,
  );
  return projects;
};

describe('deleting a project with memos (#901)', () => {
  const memos = [
    { projectId: 'p1', audioKey: 'workspaces/ws-1/memos/m1/source.mp3' },
    { projectId: 'p1', audioKey: '' },
  ];

  it('counts memos as holdings, so a project holding only memos is not empty', async () => {
    const { prisma } = fakePrisma(memos);
    await expect(service(prisma).remove('p1')).rejects.toMatchObject({
      response: { reason: 'not-empty', counts: { memos: 2 } },
    });
  });

  it('a move takes the memos and the memo settings to the destination', async () => {
    const { prisma, made } = fakePrisma(memos);
    const res = await service(prisma).remove('p1', 'u1', { moveContentsTo: 'p2' });
    expect(res.moved.memos).toBe(2);
    const moved = { where: { projectId: 'p1' }, data: { projectId: 'p2' } };
    for (const model of ['memo', 'plaudLink', 'plaudImport', 'memoType']) {
      expect(made(model, 'updateMany')).toContainEqual(moved);
    }
  });

  it('a cascade destroys the memos and purges their audio, and nulls the memo settings', async () => {
    const { prisma, made } = fakePrisma(memos);
    const storage = { purgeObjectVersions: vi.fn(async () => undefined) };
    const cascade = new ProjectCascadeService(prisma as never, storage as never, {} as never, {} as never);
    const res = await service(prisma).remove('p1', 'u1', {
      confirm: 'Old',
      cascade: (id, ws) => cascade.cascade(id, ws),
    });
    expect(res.destroyed?.memos).toBe(2);
    expect(made('memo', 'deleteMany')).toContainEqual({ where: { projectId: 'p1' } });
    expect(storage.purgeObjectVersions.mock.calls).toEqual([['workspaces/ws-1/memos/m1/source.mp3']]);
    const nulled = { where: { projectId: 'p1' }, data: { projectId: null } };
    for (const model of ['plaudLink', 'plaudImport', 'memoType']) {
      expect(made(model, 'updateMany')).toContainEqual(nulled);
    }
  });

  it('an empty project still nulls the memo settings that name it', async () => {
    const { prisma, made } = fakePrisma([]);
    await service(prisma).remove('p1');
    expect(made('plaudLink', 'updateMany')).toContainEqual({ where: { projectId: 'p1' }, data: { projectId: null } });
  });
});
