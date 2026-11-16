import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { MemoryManagementService } from '../src/memory/memory-management.service.js';

const OP = '7b0d1c5e-3f2a-4c6b-8d9e-0a1b2c3d4e5f';
const bank = { id: 'bank-mine', workspaceId: 'ws-1', bankId: 'mine', name: 'mine', mission: '', createdAt: new Date('2026-03-01T00:00:00Z') };

function service(prisma: Record<string, unknown>) {
  const config = { get: (key: string) => (key === 'MEMORY_RETAIN_MAX_ITEMS' ? 100 : 100_000) };
  const none = {} as never;
  return new MemoryManagementService(prisma as never, none, none, none, none, none, none, none, none, none, config as never);
}

describe('MemoryManagementService (#1161)', () => {
  it('never overwrites a mental model another bank holds when an archive names its id', async () => {
    const foreign = { id: 'victim-model', bankId: 'bank-other' };
    const archive = zipSync({
      'transfer.json': strToU8(JSON.stringify({
        format: 'knowledge-hindsight-transfer',
        version: '1',
        bank: { name: 'mine', mission: '', config: {} },
        documents: [],
        directives: [],
        mental_models: [{ id: foreign.id, name: 'Stolen', source_query: 'q', content: 'x' }],
      })),
    });
    const memoryMentalModel = {
      findUnique: vi.fn(async () => foreign),
      update: vi.fn(),
      create: vi.fn(async () => ({})),
    };
    const prisma = { memoryMentalModel, memoryDirective: { findFirst: vi.fn() }, memoryBank: { update: vi.fn() } };
    await service(prisma).execute({
      id: OP, workspaceId: 'ws-1', bankId: bank.id, bank, type: 'document_import', createdBy: 'u1', locale: 'en',
      payload: { data_base64: Buffer.from(archive).toString('base64'), target_bank_id: 'mine', mode: 'merge', conflict: 'skip', include_data: false, include_bank_config: true },
    } as never);
    expect(memoryMentalModel.update).not.toHaveBeenCalled();
    const created = (memoryMentalModel.create.mock.calls[0] as unknown as [{ data: { id: string; bankId: string } }])[0].data;
    expect(created.id).not.toBe(foreign.id);
    expect(created.bankId).toBe(bank.id);
  });

  it('reads audit rows from this bank lifetime only, without request IPs', async () => {
    const row = { id: 'a1', action: 'memory.bank_created', actor: 'u1', params: {}, ok: true, error: null, ip: '10.0.0.1', target: 'mine', durationMs: null, createdAt: new Date('2026-03-02T00:00:00Z') };
    const auditLog = { findMany: vi.fn(async () => [row]), count: vi.fn(async () => 1) };
    const page = await service({ auditLog }).auditLogs(bank as never, { start_date: '2020-01-01T00:00:00Z' });
    const where = (auditLog.findMany.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where;
    expect(where.createdAt.gte).toEqual(bank.createdAt);
    expect(page.items[0]!.metadata).not.toHaveProperty('ip');
  });
});
