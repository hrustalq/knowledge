import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  assertGraphNames,
  ceilingNotice,
  deleteEntitiesMessage,
  deleteObservationsMessage,
  deleteRelationsMessage,
  MAX_GRAPH_NAME_CHARS,
  newInBatch,
  observationDocumentId,
  readEntities,
  skippedEntitiesNotice,
} from '../src/memory/memory-graph.js';
import { MemoryGraphService } from '../src/memory/memory-graph.service.js';

describe('the graph wire’s rules: the reference memory server’s, word for word (#1008)', () => {
  it('skips a key already taken or earlier in the batch, keeping the first', () => {
    const items = [{ n: 'a', v: 1 }, { n: 'b', v: 2 }, { n: 'a', v: 3 }, { n: 'c', v: 4 }];
    expect(newInBatch(items, (i) => i.n, new Set(['c']))).toEqual([{ n: 'a', v: 1 }, { n: 'b', v: 2 }]);
  });

  it('says what it skipped and deleted in the reference’s words', () => {
    expect(skippedEntitiesNotice(['A'])).toBe('Skipped 1 entity that already exists: A. Its observations were not added; use add_observations for existing entities.');
    expect(skippedEntitiesNotice(['A', 'B'])).toBe('Skipped 2 entities that already exist: A, B. Their observations were not added; use add_observations for existing entities.');
    expect(deleteEntitiesMessage(2, 2, [])).toBe('Entities deleted successfully');
    expect(deleteEntitiesMessage(2, 1, ['G'])).toBe('Deleted 1 of 2 entities. Not found: G');
    expect(deleteObservationsMessage(2, 2, [])).toBe('Observations deleted successfully');
    expect(deleteObservationsMessage(3, 1, ['G'])).toBe('Deleted 1 of 3 observations. Entities not found: G');
    expect(deleteObservationsMessage(1, 0, [])).toBe('Deleted 0 of 1 observations.');
    expect(deleteRelationsMessage(0, 0)).toBe('Relations deleted successfully');
    expect(deleteRelationsMessage(2, 1)).toBe('Deleted 1 of 2 relations. The rest matched nothing.');
    expect(ceilingNotice(500)).toMatch(/^Showing only the first 500 entities/);
  });

  it('numbers observations so their document ids sort in the order added', () => {
    const ids = [1, 2, 10, 100].map((n) => observationDocumentId('e', n));
    expect(ids).toEqual([...ids].sort());
    expect(ids[0]).toBe('graph:e:0000000001');
  });

  it('caps observations per entity and counts them only when a limit is given', () => {
    const rows = [{ id: '1', name: 'A', entityType: 't' }, { id: '2', name: 'B', entityType: 't' }];
    const held = new Map([['1', { texts: ['x', 'y'], total: 2 }]]);
    expect(readEntities(rows, held, undefined)).toEqual([{ name: 'A', entityType: 't', observations: ['x', 'y'] }, { name: 'B', entityType: 't', observations: [] }]);
    expect(readEntities(rows, held, 1)).toEqual([{ name: 'A', entityType: 't', observations: ['x'], observationCount: 2 }, { name: 'B', entityType: 't', observations: [], observationCount: 0 }]);
    expect(readEntities(rows, held, 0)[0]).toEqual({ name: 'A', entityType: 't', observations: [], observationCount: 2 });
  });

  it('refuses a name or type too long for its index', () => {
    expect(() => assertGraphNames(['x'.repeat(MAX_GRAPH_NAME_CHARS)])).not.toThrow();
    expect(() => assertGraphNames(['ok', 'x'.repeat(MAX_GRAPH_NAME_CHARS + 1)])).toThrow(BadRequestException);
  });
});

describe('MemoryGraphService (#1008)', () => {
  const bank = { id: 'bank-row', bankId: 'agent', workspaceId: 'ws-1' };
  const caller = { principal: { userId: 'u1', locale: 'en' }, workspaceId: 'ws-1' };

  function service(opts: { bank?: typeof bank | null; storeFails?: boolean; max?: number; entities?: number } = {}) {
    const calls: string[] = [];
    const prisma = {
      memoryEntity: {
        findMany: vi.fn(async (args: { where: { id?: { in: string[] } }; take?: number }) => {
          if (args.where.id) return args.where.id.in.map((id) => ({ id }));
          return Array.from({ length: Math.min(opts.entities ?? 0, args.take ?? Infinity) }, (_, i) => ({ id: `e${i}`, name: `E${i}`, entityType: 't' }));
        }),
        createMany: vi.fn(async () => (calls.push('entities'), { count: 1 })),
        deleteMany: vi.fn(async () => (calls.push('undo'), { count: 1 })),
      },
      $queryRaw: vi.fn(async () => []),
    };
    const access = { find: vi.fn(async () => (opts.bank === undefined ? bank : opts.bank)) };
    const intake = {
      admit: vi.fn(async () => (calls.push('admit'), bank)),
      store: vi.fn(async () => {
        calls.push('store');
        if (opts.storeFails) throw new Error('store not ready');
        return 1;
      }),
    };
    const units = { deleteWhere: vi.fn(async (_b: unknown, _w: unknown, alongside?: () => Promise<unknown>) => (await alongside?.(), { matched: 1, ids: ['u1'] })) };
    const rate = { check: vi.fn(async (verb: string) => void calls.push(`rate:${verb}`)) };
    const config = { get: () => opts.max ?? 500 };
    return { svc: new MemoryGraphService(prisma as never, access as never, intake as never, units as never, rate as never, config as never), calls, prisma, intake, units, rate };
  }

  it('admits before it writes, writes entity rows before their observations, and takes the rows back when the store fails', async () => {
    const ok = service({ bank: null });
    const res = await ok.svc.createEntities(caller as never, 'agent', [{ name: 'Alice', entityType: 'person', observations: ['mail me at a@b.co'] }]);
    expect(ok.calls).toEqual(['admit', 'entities', 'store']);
    expect(res).toEqual({ created: [{ name: 'Alice', entityType: 'person', observations: ['mail me at [EMAIL_1]'] }], skipped: [] });
    const [, , items, options] = ok.intake.store.mock.calls[0] as unknown as [unknown, unknown, Array<Record<string, unknown>>, unknown];
    expect(options).toEqual({ verbatim: true });
    expect(items[0]).toMatchObject({ content: 'mail me at [EMAIL_1]', context: 'Alice (person)', entities: [{ name: 'Alice', key: 'alice' }], append: false });
    expect(items[0]!.documentId).toMatch(/^graph:[0-9a-f-]{36}:0000000001$/);

    const failing = service({ bank: null, storeFails: true });
    await expect(failing.svc.createEntities(caller as never, 'agent', [{ name: 'Alice', entityType: 'person', observations: ['x'] }])).rejects.toThrow('store not ready');
    expect(failing.calls).toEqual(['admit', 'entities', 'store', 'undo']);
  });

  it('errors on a relation to a missing entity before it spends the rate or writes', async () => {
    const { svc, rate } = service({ bank: null });
    await expect(svc.createRelations(caller as never, 'agent', [{ from: 'A', to: 'B', relationType: 'r' }])).rejects.toThrow('Entity with name A not found');
    expect(rate.check).not.toHaveBeenCalled();
  });

  it('reads a bank that does not exist as an empty graph, on the recall rate, and creates nothing', async () => {
    const { svc, rate, intake } = service({ bank: null });
    expect(await svc.read(caller as never, 'agent', {})).toEqual({ graph: { entities: [], relations: [] }, capped: false });
    expect(await svc.open(caller as never, 'agent', ['A'], {})).toEqual({ entities: [], relations: [] });
    expect(rate.check.mock.calls.map((c) => c[0])).toEqual(['recall', 'recall']);
    expect(intake.admit).not.toHaveBeenCalled();
  });

  it('cuts a read at the ceiling and says so; a search limit under it is no cut', async () => {
    const { svc } = service({ max: 2, entities: 5 });
    const read = await svc.read(caller as never, 'agent', {});
    expect(read.capped).toBe(true);
    expect(read.graph.entities.map((e) => e.name)).toEqual(['E0', 'E1']);
    expect((await service({ max: 2, entities: 2 }).svc.read(caller as never, 'agent', {})).capped).toBe(false);
  });

  it('deletes an entity’s observations with its row in one locked pass, on the retain rate', async () => {
    const { svc, units, prisma, rate } = service({ entities: 1 });
    prisma.memoryEntity.findMany.mockResolvedValueOnce([{ id: 'e0', name: 'E0', entityType: 't' }]);
    expect(await svc.deleteEntities(caller as never, 'agent', ['E0', 'Ghost'])).toBe('Deleted 1 of 2 entities. Not found: Ghost');
    expect(units.deleteWhere).toHaveBeenCalledWith(bank, { factType: { not: 'observation' }, OR: [{ documentId: { startsWith: 'graph:e0:' } }] }, expect.any(Function));
    expect(prisma.memoryEntity.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['e0'] } } });
    expect(rate.check).toHaveBeenCalledWith('retain', caller.principal);
  });
});
