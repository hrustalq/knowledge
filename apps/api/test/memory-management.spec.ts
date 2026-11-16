import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { MemoryManagementService, splitText } from '../src/memory/memory-management.service.js';

const OP = '7b0d1c5e-3f2a-4c6b-8d9e-0a1b2c3d4e5f';
const bank = { id: 'bank-mine', workspaceId: 'ws-1', bankId: 'mine', name: 'mine', mission: '', projectId: null, agentKey: null, ownerId: null, disposition: {}, createdAt: new Date('2026-03-01T00:00:00Z') };

interface Deps {
  prisma?: Record<string, unknown>;
  access?: Record<string, unknown>;
  directives?: Record<string, unknown>;
  mentalModels?: Record<string, unknown>;
  retainer?: Record<string, unknown>;
  units?: Record<string, unknown>;
  parsers?: Record<string, unknown>;
  producer?: Record<string, unknown>;
  limits?: { maxItems: number; maxChars: number };
}

function service(deps: Deps = {}) {
  const limits = deps.limits ?? { maxItems: 100, maxChars: 100_000 };
  const config = { get: (key: string) => (key === 'MEMORY_RETAIN_MAX_ITEMS' ? limits.maxItems : limits.maxChars) };
  const none = {} as never;
  return new MemoryManagementService(
    (deps.prisma ?? {}) as never,
    (deps.access ?? none) as never,
    none,
    (deps.directives ?? none) as never,
    (deps.mentalModels ?? { validateDefinition: (dto: { trigger?: unknown }) => dto.trigger ?? {} }) as never,
    (deps.retainer ?? none) as never,
    (deps.units ?? none) as never,
    (deps.parsers ?? none) as never,
    (deps.producer ?? none) as never,
    config as never,
  );
}

const archive = (transfer: Record<string, unknown>) => Buffer.from(zipSync({
  'transfer.json': strToU8(JSON.stringify({ format: 'knowledge-hindsight-transfer', version: '1', bank: { name: 'mine', mission: '', config: {} }, documents: [], directives: [], mental_models: [], ...transfer })),
})).toString('base64');

const importRow = (payload: Record<string, unknown>) => ({
  id: OP, workspaceId: 'ws-1', bankId: bank.id, bank, type: 'bank_import', createdBy: 'u1', locale: 'en',
  payload: { target_bank_id: 'restored', mode: 'restore', conflict: 'skip', include_data: true, include_bank_config: true, ...payload },
}) as never;

const item = (content: string) => ({ content, context: null, timestamp: null, metadata: {}, tags: [], entities: [] });

describe('MemoryManagementService (#1161)', () => {
  it('imports an archive mental model as a definition in this bank only, never its content or evidence', async () => {
    const memoryMentalModel = { updateMany: vi.fn(async () => ({ count: 0 })), create: vi.fn(async () => ({})) };
    const prisma = { memoryMentalModel, memoryDirective: { findFirst: vi.fn() }, memoryBank: { update: vi.fn() } };
    await service({ prisma }).execute(importRow({
      mode: 'merge', include_data: false, target_bank_id: 'mine',
      data_base64: archive({ mental_models: [{ id: 'victim-model', name: 'Stolen', source_query: 'q', content: 'planted', reflect_response: { text: 'planted' }, structured_doc: { x: 1 }, max_tokens: 10, trigger: { refresh_after_consolidation: false } }] }),
    }));
    expect(memoryMentalModel.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { bankId: bank.id, id: 'victim-model' } }));
    const created = (memoryMentalModel.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(created).toMatchObject({ id: 'victim-model', bankId: bank.id, content: '', name: 'Stolen', sourceQuery: 'q', maxTokens: 10 });
    expect(created).not.toHaveProperty('reflectResponse');
    expect(created).not.toHaveProperty('structuredDoc');
  });

  it('gives an archive model a fresh id where another bank holds its id', async () => {
    const memoryMentalModel = {
      updateMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn().mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' })).mockResolvedValue({}),
    };
    const prisma = { memoryMentalModel, memoryDirective: { findFirst: vi.fn() }, memoryBank: { update: vi.fn() } };
    await service({ prisma }).execute(importRow({ mode: 'merge', include_data: false, target_bank_id: 'mine', data_base64: archive({ mental_models: [{ id: 'victim-model', name: 'n', source_query: 'q' }] }) }));
    const retried = (memoryMentalModel.create.mock.calls[1] as unknown as [{ data: { id: string; bankId: string } }])[0].data;
    expect(retried.id).not.toBe('victim-model');
    expect(retried.bankId).toBe(bank.id);
  });

  it('checks the whole archive before writing: a bad mental model creates no target bank', async () => {
    const memoryBank = { create: vi.fn(), update: vi.fn() };
    const mentalModels = { validateDefinition: vi.fn(() => { throw new BadRequestException('bad id'); }) };
    const prisma = { memoryBank, memoryBankAlias: { findUnique: vi.fn(async () => null) } };
    await expect(service({ prisma, mentalModels }).execute(importRow({ data_base64: archive({ mental_models: [{ id: 'Bad Id', name: 'n', source_query: 'q' }] }) }))).rejects.toBeInstanceOf(BadRequestException);
    expect(memoryBank.create).not.toHaveBeenCalled();
  });

  it('removes a restore target it made when the import fails, so a retry finds the id free', async () => {
    const target = { ...bank, id: 'bank-new', bankId: 'restored' };
    const memoryBank = { create: vi.fn(async () => target), update: vi.fn(), delete: vi.fn(async () => target) };
    const prisma = { memoryBank, memoryBankAlias: { findUnique: vi.fn(async () => null) }, memoryUnit: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => [{ id: 'u1' }]) } };
    const retainer = { retain: vi.fn(async () => { throw new Error('arcade down'); }) };
    const units = { dropVectors: vi.fn(async () => undefined) };
    await expect(service({ prisma, retainer, units }).execute(importRow({ data_base64: archive({ documents: [{ id: 'd1', items: [item('a')] }] }) }))).rejects.toThrow('arcade down');
    expect(memoryBank.delete).toHaveBeenCalledWith({ where: { id: 'bank-new' } });
    expect(units.dropVectors).toHaveBeenCalledWith('ws-1', ['u1']);
  });

  it('skips wire documents in an archive, and retains a long document in runs that append', async () => {
    const memoryBank = { update: vi.fn() };
    const prisma = { memoryBank, memoryUnit: { findFirst: vi.fn(async () => null) } };
    const retainer = { retain: vi.fn(async (input: { items: unknown[] }) => ({ units: input.items.length })) };
    const result = await service({ prisma, retainer, limits: { maxItems: 2, maxChars: 1000 } }).execute(importRow({
      mode: 'merge', target_bank_id: 'mine', include_bank_config: false,
      data_base64: archive({ documents: [{ id: 'file:/notes.md', items: [item('chunk')] }, { id: 'graph:e1:1', items: [item('obs')] }, { id: 'd1', items: [item('a'), item('b'), item('c')] }] }),
    }));
    const calls = retainer.retain.mock.calls as unknown as Array<[{ items: Array<{ documentId: string; append: boolean; timestamp: string | null }> }]>;
    expect(calls.map(([c]) => c.items.map((i) => [i.documentId, i.append]))).toEqual([[['d1', false], ['d1', false]], [['d1', true]]]);
    expect(calls[0]![0].items[0]!.timestamp).toBeNull();
    expect(result).toMatchObject({ documents_imported: 1, documents_skipped_reserved: 2, facts_imported: 3 });
  });

  it('exports no wire documents, and says how many it left out', async () => {
    const unit = (documentId: string) => ({ documentId, text: documentId, context: null, mentionedAt: null, metadata: {}, tags: [], observationScopes: null, entities: [] });
    const memoryTransferArchive = { create: vi.fn(async () => ({})) };
    const prisma = { memoryUnit: { findMany: vi.fn(async () => [unit('d1'), unit('file:/a.md'), unit('file:/a.md'), unit('graph:e:1')]) }, memoryTransferArchive };
    const result = await service({ prisma }).execute({ ...(importRow({}) as object), type: 'document_export', payload: { document_ids: null, include_data: true, include_bank_config: false, include_knowledge_base: false } } as never);
    expect(result).toMatchObject({ documents_exported: 1, facts_exported: 1, documents_skipped_reserved: 2 });
    const data = (memoryTransferArchive.create.mock.calls[0] as unknown as [{ data: { data: Buffer } }])[0].data.data;
    const transfer = JSON.parse(Buffer.from(unzipSync(new Uint8Array(data))['transfer.json']!).toString('utf8')) as { documents: Array<{ id: string }> };
    expect(transfer.documents.map((d) => d.id)).toEqual(['d1']);
  });

  it('masks a parsed file before retaining it, and splits it into items within the ceilings', async () => {
    const markdown = ['Deploy key sk-abcdefghijklmnopqrstuvwx', 'b'.repeat(30), 'c'.repeat(45)].join('\n\n');
    const parsers = { resolve: () => ({ parse: async () => ({ markdown, warnings: [] }) }) };
    const retainer = { retain: vi.fn(async (input: { items: unknown[] }) => ({ units: input.items.length })) };
    const row = { ...(importRow({}) as object), type: 'file_convert_retain', payload: { filename: 'notes.md', content_type: 'text/markdown', data_base64: '', metadata: {} } } as never;
    const result = await service({ parsers, retainer, limits: { maxItems: 2, maxChars: 40 } }).execute(row);
    const calls = retainer.retain.mock.calls as unknown as Array<[{ items: Array<{ content: string; documentId: string; append: boolean }>; operationId?: string }]>;
    const items = calls.flatMap(([c]) => c.items);
    expect(items.every((i) => i.content.length <= 40 && i.documentId === 'notes.md')).toBe(true);
    expect(items.map((i) => i.content).join('')).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(items[0]!.content).toContain('[SECRET_1]');
    expect(calls.map(([c]) => c.items.length)).toEqual([2, 2]);
    expect(calls[0]![0].operationId).toBe(OP);
    expect(calls[1]![0]).not.toHaveProperty('operationId');
    expect(calls[1]![0].items.every((i) => i.append)).toBe(true);
    expect(result).toMatchObject({ documents_imported: 1, facts_imported: 4 });
  });

  it('splits text on paragraph boundaries, cutting only a paragraph longer than the ceiling', () => {
    expect(splitText('aa\n\nbb\n\ncc', 6)).toEqual(['aa\n\nbb', 'cc']);
    expect(splitText('abcdefgh', 3)).toEqual(['abc', 'def', 'gh']);
  });

  it('finds an archive only in the caller workspace', async () => {
    const memoryTransferArchive = { findFirst: vi.fn(async () => null) };
    await expect(service({ prisma: { memoryTransferArchive } }).archive({ workspaceId: 'ws-1', scope: {} } as never, OP)).rejects.toThrow();
    expect(memoryTransferArchive.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: OP, workspaceId: 'ws-1' } }));
  });

  it('refuses a reserved bank id as an alias or a restore target', async () => {
    const caller = { workspaceId: 'ws-1', principal: { userId: 'u1', locale: 'en' } } as never;
    const access = { bank: vi.fn(async () => bank), find: vi.fn(async () => null) };
    const svc = service({ access });
    await expect(svc.createAlias(caller, 'mine', { alias: 'project:11111111-1111-4111-8111-111111111111' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submitClone(caller, 'mine', { target_bank_id: 'agent:assistant:user:u2' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.submitImport(caller, 'mine', { buffer: Buffer.from(''), size: 0 }, { target_bank_id: 'project:x' }, false)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps a submitted operation when the queue is down: the sweeper enqueues it', async () => {
    const memoryOperation = { create: vi.fn(async () => ({})) };
    const producer = { enqueue: vi.fn(async () => { throw new Error('redis down'); }) };
    const result = await service({ prisma: { memoryOperation }, producer }).submitExport(bank as never, {}, true, 'u1', 'en');
    expect(result.status).toBe('pending');
    expect(memoryOperation.create).toHaveBeenCalled();
  });

  it('refuses a restore into a bank id an alias holds, before writing', async () => {
    const memoryBank = { create: vi.fn() };
    const prisma = { memoryBank, memoryBankAlias: { findUnique: vi.fn(async () => ({ id: 'a1' })) } };
    await expect(service({ prisma }).execute(importRow({ data_base64: archive({}) }))).rejects.toBeInstanceOf(ConflictException);
    expect(memoryBank.create).not.toHaveBeenCalled();
  });

  it('reads audit rows from this bank lifetime only, without request IPs', async () => {
    const row = { id: 'a1', action: 'memory.bank_created', actor: 'u1', params: {}, ok: true, error: null, ip: '10.0.0.1', target: 'mine', durationMs: null, createdAt: new Date('2026-03-02T00:00:00Z') };
    const auditLog = { findMany: vi.fn(async () => [row]), count: vi.fn(async () => 1) };
    const page = await service({ prisma: { auditLog } }).auditLogs(bank as never, { start_date: '2020-01-01T00:00:00Z' });
    const where = (auditLog.findMany.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where;
    expect(where.createdAt.gte).toEqual(bank.createdAt);
    expect(page.items[0]!.metadata).not.toHaveProperty('ip');
  });

  it('counts audit stats from the later of the period start and the bank creation', async () => {
    const auditLog = { findMany: vi.fn(async () => []) };
    const young = { ...bank, createdAt: new Date(Date.now() - 3_600_000) };
    await service({ prisma: { auditLog } }).auditStats(young as never, { period: '30d' });
    const where = (auditLog.findMany.mock.calls[0] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where;
    expect(where.createdAt.gte).toEqual(young.createdAt);
    await service({ prisma: { auditLog } }).auditStats(bank as never, { period: '1d' });
    const later = (auditLog.findMany.mock.calls[1] as unknown as [{ where: { createdAt: { gte: Date } } }])[0].where;
    expect(later.createdAt.gte.getTime()).toBeGreaterThan(Date.now() - 86_400_000 - 5000);
  });
});
