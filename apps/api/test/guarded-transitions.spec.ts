import { describe, expect, it, vi } from 'vitest';
import { ConnectorProcessor } from '../src/connectors/connector.processor.js';
import { WorkflowsService } from '../src/workflows/workflows.service.js';

/**
 * #810: a status transition is written with the status it was checked
 * against, so a change that lands between the read and the write stands.
 * Each fake row honours `where.status` the way Postgres would; the
 * interleaving is the one the issue names.
 */
type Row = Record<string, unknown>;

/** A one-row table whose guarded writes match on `status` (a value or `{ in }`). */
function guardedRow(row: Row) {
  const matches = (where: Row) => {
    const s = where.status as string | { in: string[] } | undefined;
    return s === undefined || (typeof s === 'string' ? row.status === s : s.in.includes(row.status as string));
  };
  return {
    row,
    findUnique: vi.fn(async () => ({ ...row })),
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      if (!matches(where)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
  };
}

const _ = {} as never;

describe('#810 connector run: a PAUSE or CANCEL during a slice stands', () => {
  function rig(during: (row: Row) => void) {
    const run = guardedRow({ id: 'run1', workspaceId: 'ws', connectorId: 'c1', status: 'queued', phase: 'discovering', discovered: 4, applied: 0 });
    const prisma = {
      connectorRun: run,
      connectorRunItem: { updateMany: vi.fn(async () => ({ count: 0 })) },
      connector: { findUnique: vi.fn(async () => ({ id: 'c1', name: 'Wiki' })) },
    };
    const sync = {
      run: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20)); // past the 90 % yield point
        during(run.row);
        return { done: false };
      }),
    };
    const producer = { enqueueRetry: vi.fn(async () => undefined) };
    const events = { publish: vi.fn(async () => undefined) };
    const config = { get: () => 10 };
    const processor = new ConnectorProcessor(prisma as never, config as never, _, sync as never, producer as never, events as never, _);
    const execute = (processor as unknown as { execute: (id: string) => Promise<void> }).execute.bind(processor);
    return { run: run.row, producer, events, execute };
  }

  it('an untouched run checkpoints and is re-queued for its next slice', async () => {
    const r = rig(() => undefined);
    await r.execute('run1');
    expect(r.run.status).toBe('queued');
    expect(r.producer.enqueueRetry).toHaveBeenCalledOnce();
  });

  it('a PAUSE that landed mid-slice leaves the run paused, with no continuation', async () => {
    const r = rig((row) => (row.status = 'paused'));
    await r.execute('run1');
    expect(r.run.status).toBe('paused');
    expect(r.producer.enqueueRetry).not.toHaveBeenCalled();
  });

  it('a slice that fails after a CANCEL leaves the run cancelled and announces no failure', async () => {
    const r = rig((row) => {
      row.status = 'cancelled';
      throw new Error('upstream went away');
    });
    await r.execute('run1');
    expect(r.run.status).toBe('cancelled');
    expect(r.events.publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'connector.run.failed' }));
  });
});

describe('#810 workflow node: concurrent review actions', () => {
  it('APPROVE and REJECT at once: exactly one wins, the other is a 409', async () => {
    const node = guardedRow({ id: 'n1', runId: 'run1', stepId: 's1', status: 'awaiting-review', draft: null, attempt: 0, createdAt: new Date(), updatedAt: new Date() });
    const run = { id: 'run1', workspaceId: 'ws', status: 'running', snapshot: null, rootDocumentId: 'd1', definitionSnapshot: { steps: [{ id: 's1', next: [] }] } };
    const prisma = {
      workflowRunNode: node,
      withTransaction: async <T>(fn: () => Promise<T>) => fn(),
      onCommit: () => undefined,
    };
    const runner = { spawnChildren: vi.fn(async () => undefined) };
    const svc = Object.assign(new WorkflowsService(prisma as never, _, _, _, runner as never, _), {
      // Both actions read the node before either writes.
      requireNode: async () => ({ ...node.row }),
      requireRun: async () => run,
      reconcileRun: async () => ({}),
    });

    const results = await Promise.allSettled([
      svc.sendNodeEvent('run1', 'n1', 'APPROVE', undefined, 'u1', vi.fn()),
      svc.sendNodeEvent('run1', 'n1', 'REJECT', undefined, 'u2', vi.fn()),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409 });
    expect(node.row.status).toBe('approved');
    expect(runner.spawnChildren).toHaveBeenCalledOnce();
  });
});
