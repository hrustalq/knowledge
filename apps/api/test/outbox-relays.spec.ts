import { describe, expect, it, vi } from 'vitest';
import { ConnectorScheduleSweeper } from '../src/connectors/connector-schedule.sweeper.js';
import { ImportRelaySweeper } from '../src/import/import-relay.sweeper.js';
import { ImportService } from '../src/import/import.service.js';

/**
 * The outbox relays (#657): a row committed before its job is enqueued again
 * when the job was lost, under a jobId that a still-live job absorbs.
 * Agent runs and memos are covered in agent-schedule.spec.ts and memos.spec.ts.
 */
describe('ConnectorScheduleSweeper — queued-run relay', () => {
  function sweeperWith(
    stale: Array<{ id: string; phase: string | null }>,
    schedulesEnabled = false,
    stuck: Array<{ id: string; attempt: number }> = [],
  ) {
    const prisma = {
      connectorRun: {
        findMany: vi.fn(async ({ where }: { where: { status: string } }) => (where.status === 'running' ? stuck : stale)),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      connector: { findMany: vi.fn(async () => []) },
    };
    const producer = { enqueue: vi.fn(async () => undefined), enqueueRetry: vi.fn(async () => undefined) };
    const config = { get: (key: string) => (key === 'CONNECTOR_SYNC_TIMEOUT_MS' ? 600_000 : schedulesEnabled) };
    const sweeper = new ConnectorScheduleSweeper(prisma as never, {} as never, producer as never, config as never);
    sweeper.onModuleInit();
    sweeper.onModuleDestroy();
    return { sweeper, prisma, producer };
  }

  it('re-enqueues a first slice under its own id and a continuation under one relay id, with schedules off', async () => {
    const { sweeper, prisma, producer } = sweeperWith([
      { id: 'first', phase: null },
      { id: 'resumed', phase: 'discover' },
    ]);
    await sweeper.sweep();
    expect(producer.enqueue).toHaveBeenCalledExactlyOnceWith('first');
    expect(producer.enqueueRetry).toHaveBeenCalledExactlyOnceWith('resumed', 'relay');
    expect(prisma.connectorRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'queued' }) }),
    );
    expect(prisma.connector.findMany).not.toHaveBeenCalled();
  });

  it('re-queues a running run its worker abandoned, by a guarded reset, and fails one out of attempts (#809)', async () => {
    const { sweeper, prisma, producer } = sweeperWith([], false, [
      { id: 'crashed', attempt: 0 },
      { id: 'cursed', attempt: 3 },
    ]);
    await sweeper.sweep();
    const writes = prisma.connectorRun.updateMany.mock.calls as unknown as Array<
      [{ where: { id: string; status: string; startedAt: { lt: Date } }; data: { status: string } }]
    >;
    const reset = writes.find(([w]) => w.where.id === 'crashed')![0];
    expect(reset.where.status).toBe('running');
    // Twice the sync timeout: a live slice yields or aborts within one.
    expect(reset.where.startedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 1_200_000);
    expect(reset.data).toEqual({ status: 'queued', attempt: { increment: 1 } });
    expect(producer.enqueueRetry).toHaveBeenCalledExactlyOnceWith('crashed', 'stale-1');
    const failed = writes.find(([w]) => w.where.id === 'cursed')![0];
    expect(failed.data).toMatchObject({ status: 'failed', completedAt: expect.any(Date) });
  });

  it('enqueues nothing when no run is stale', async () => {
    const { sweeper, producer } = sweeperWith([], true);
    await sweeper.sweep();
    expect(producer.enqueue).not.toHaveBeenCalled();
    expect(producer.enqueueRetry).not.toHaveBeenCalled();
  });
});

describe('ImportRelaySweeper', () => {
  it('re-enqueues a stale queued import once, and nothing when none is stale', async () => {
    const findMany = vi.fn(async () => [{ id: 'imp-1' }]);
    const producer = { enqueue: vi.fn(async () => undefined) };
    const sweeper = new ImportRelaySweeper({ importJob: { findMany } } as never, producer as never);
    await sweeper.sweep();
    expect(producer.enqueue).toHaveBeenCalledExactlyOnceWith('imp-1');
    const where = (findMany.mock.calls[0] as unknown as [{ where: { status: string; createdAt: { lt: Date } } }])[0].where;
    expect(where.status).toBe('queued');
    expect(where.createdAt.lt.getTime()).toBeLessThan(Date.now() - 9 * 60_000);

    findMany.mockResolvedValueOnce([]);
    producer.enqueue.mockClear();
    await sweeper.sweep();
    expect(producer.enqueue).not.toHaveBeenCalled();
  });
});

describe('ImportService.start on a queued row', () => {
  it('enqueues again instead of returning early', async () => {
    const row = { id: 'imp-1', workspaceId: 'ws', status: 'queued', createdAt: new Date() };
    const service = Object.create(ImportService.prototype) as ImportService;
    const producer = { enqueue: vi.fn(async () => undefined) };
    Object.assign(service, { producer, require: vi.fn(async () => row) });
    await expect(service.start('imp-1')).resolves.toMatchObject({ importId: 'imp-1', status: 'queued' });
    expect(producer.enqueue).toHaveBeenCalledExactlyOnceWith('imp-1');
  });
});
