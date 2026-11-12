import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MemoryOperationsService } from '../src/memory/memory-operations.service.js';
import type { RetainItem } from '../src/memory/memory-facts.js';

const bank = { id: 'bank-1', workspaceId: 'ws-1', bankId: 'agent', mission: '' } as never;
const item: RetainItem = { content: 'Key sk-abcdefghijklmnopqrstuvwx for bob@example.com', context: null, timestamp: null, metadata: {}, documentId: 'd1', entities: [], tags: [], append: false };
const OP = '7b0d1c5e-3f2a-4c6b-8d9e-0a1b2c3d4e5f';

function service(opts: { held?: { bankId: string }; claim?: number; row?: Record<string, unknown> | null; retain?: Error } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const prisma = {
    memoryOperation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.held) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        created.push(data);
      }),
      findUnique: vi.fn(async () => opts.held ?? opts.row ?? null),
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: args.data.status === 'running' ? (opts.claim ?? 1) : 1 };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      count: vi.fn(async () => 0),
    },
  };
  const retainer = { retain: vi.fn(async () => { if (opts.retain) throw opts.retain; return { units: 1, usage: null }; }) };
  const producer = { enqueue: vi.fn(async () => undefined) };
  const config = { get: (key: string) => (key === 'MEMORY_OPERATION_TIMEOUT_MS' ? 600_000 : 7) };
  return { svc: new MemoryOperationsService(prisma as never, retainer as never, producer as never, config as never), prisma, retainer, producer, created, updates };
}

describe('MemoryOperationsService (#986)', () => {
  it('stores the items masked and enqueues a job that carries only the row id', async () => {
    const { svc, created, producer } = service();
    const id = await svc.submit(bank, { items: [item], userId: 'u1', locale: 'en', operationId: OP });
    expect(id).toBe(OP);
    expect(JSON.stringify(created[0]!.payload)).toBe(JSON.stringify([{ ...item, content: 'Key [SECRET_1] for [EMAIL_1]' }]));
    expect(created[0]).toMatchObject({ id: OP, bankId: 'bank-1', workspaceId: 'ws-1', itemsCount: 1, createdBy: 'u1' });
    expect(producer.enqueue).toHaveBeenCalledWith(OP);
  });

  it('returns the operation an operation_id already made, enqueuing nothing, and refuses one another bank holds', async () => {
    const same = service({ held: { bankId: 'bank-1' } });
    expect(await same.svc.submit(bank, { items: [item], userId: 'u1', locale: 'en', operationId: OP })).toBe(OP);
    expect(same.producer.enqueue).not.toHaveBeenCalled();
    await expect(service({ held: { bankId: 'bank-2' } }).svc.submit(bank, { items: [item], userId: 'u1', locale: 'en', operationId: OP })).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps the row when the queue is down: the sweeper will enqueue it', async () => {
    const { svc, producer, created } = service();
    producer.enqueue.mockRejectedValueOnce(new Error('redis down'));
    await expect(svc.submit(bank, { items: [item], userId: 'u1', locale: 'en' })).resolves.toEqual(expect.any(String));
    expect(created).toHaveLength(1);
  });

  it('claims with one guarded statement, retains as the operation, and settles', async () => {
    const row = { id: OP, workspaceId: 'ws-1', bank, createdBy: 'u1', locale: 'ru', payload: [item] };
    const { svc, retainer, updates } = service({ row });
    await svc.run(OP);
    expect(updates[0]).toMatchObject({ where: { id: OP, status: 'queued' }, data: { status: 'running', attempts: { increment: 1 } } });
    expect(retainer.retain).toHaveBeenCalledWith({ workspaceId: 'ws-1', bank, userId: 'u1', locale: 'ru', items: [item], operationId: OP });
    expect(updates[1]).toMatchObject({ where: { id: OP, status: 'running' }, data: { status: 'completed', payload: [] } });

    const lost = service({ row, claim: 0 });
    await lost.svc.run(OP);
    expect(lost.retainer.retain).not.toHaveBeenCalled();

    const failing = service({ row, retain: new Error('arcade down') });
    await failing.svc.run(OP);
    expect(failing.updates[1]).toMatchObject({ where: { id: OP, status: 'running' }, data: { status: 'failed', error: 'arcade down' } });
  });

  it('cancels only what is still queued, in this bank', async () => {
    const { svc, updates } = service();
    await svc.cancel(bank, OP);
    expect(updates[0]!.where).toEqual({ id: OP, bankId: 'bank-1', status: 'queued' });
    await expect(svc.cancel(bank, 'not-a-uuid')).rejects.toBeInstanceOf(ConflictException);
  });
});
