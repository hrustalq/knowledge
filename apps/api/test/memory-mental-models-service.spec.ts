import { describe, expect, it, vi } from 'vitest';
import { MemoryMentalModelsService } from '../src/memory/memory-mental-models.service.js';
import { mentalModelScope, parseMentalModelDocument } from '../src/memory/memory-mental-models.js';

const OP = '7b0d1c5e-3f2a-4c6b-8d9e-0a1b2c3d4e5f';
const bank = { id: 'bank-1', workspaceId: 'ws-1', bankId: 'agent', createdBy: 'u1' };
const baseModel = {
  id: 'model-1',
  workspaceId: 'ws-1',
  bankId: 'bank-1',
  name: 'Owners',
  sourceQuery: 'Who owns billing?',
  content: '',
  tags: [],
  maxTokens: 4096,
  trigger: {},
  reflectResponse: null,
  structuredDoc: null,
  refreshedSourceQuery: null,
  refreshedScope: null as string | null,
  lastRefreshedAt: null,
  lastMemorySeenAt: null,
  lastRefreshFailedAt: null,
  lastFullRefreshedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

type Evidence = { id: string };
function fixture(options: { latest?: boolean; delta?: boolean; reply?: Error; gone?: boolean; previous?: Evidence[]; answered?: Evidence[]; live?: string[]; model?: Record<string, unknown> } = {}) {
  const model = {
    ...baseModel,
    ...(options.delta ? {
      content: '# Owners\n\nAlice owns billing.\n',
      trigger: { mode: 'delta' },
      structuredDoc: parseMentalModelDocument('# Owners\n\nAlice owns billing.\n'),
      refreshedSourceQuery: 'Who owns billing?',
      refreshedScope: mentalModelScope({ tags: [], trigger: { mode: 'delta' } }),
      lastMemorySeenAt: new Date('2026-01-01T00:00:00Z'),
      reflectResponse: { text: '', based_on: { memories: options.previous ?? [], mental_models: [], directives: [] } },
    } : {}),
    ...options.model,
  };
  const operation = {
    id: OP,
    workspaceId: 'ws-1',
    bankId: 'bank-1',
    bank,
    type: 'refresh_mental_model',
    status: 'queued',
    payload: { mental_model_id: model.id },
    createdBy: 'u1',
    locale: 'en',
    attempts: 0,
  };
  const modelUpdates: Array<Record<string, unknown>> = [];
  const operationUpdates: Array<Record<string, unknown>> = [];
  const histories: Array<Record<string, unknown>> = [];
  const modelWheres: Array<Record<string, unknown>> = [];
  const operationDelegate = {
    findUnique: vi.fn(async () => operation),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => operation),
    update: vi.fn(async () => operation),
    updateMany: vi.fn(async (args: Record<string, unknown>) => {
      operationUpdates.push(args);
      return { count: 1 };
    }),
  };
  const prisma = {
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ now: new Date('2026-02-01T00:00:00Z') }]),
    memoryOperation: operationDelegate,
    memoryBank: { findMany: vi.fn(async () => [] as Array<{ id: string; memoriesDeletedAt: Date | null }>) },
    memoryMentalModel: {
      // The refresh's final write re-reads by (bank, id, createdAt); `gone` = deleted (or re-created) meanwhile.
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => options.gone && 'createdAt' in args.where ? null : model),
      findMany: vi.fn(async () => [model]),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        modelUpdates.push(args.data);
        return model;
      }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        modelUpdates.push(args.data);
        modelWheres.push(args.where);
        return { count: 1 };
      }),
      delete: vi.fn(async () => model),
    },
    memoryMentalModelHistory: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => { histories.push(args.data); }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    memoryUnit: {
      findFirst: vi.fn(async () => options.latest === false ? null : { updatedAt: new Date('2026-01-15T00:00:00Z') }),
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.filter((id) => !options.live || options.live.includes(id)).map((id) => ({ id }))),
    },
  };
  const reflector = {
    reflect: vi.fn(async () => {
      if (options.reply) throw options.reply;
      return options.delta
        ? {
            text: '{"operations":[{"op":"replace_block","section_id":"missing","block_id":"none","content":"gone"}]}',
            delta_operations: options.answered
              ? [{ op: 'append_block', section_id: 's1', content: 'Bob owns invoicing.' }]
              : [{ op: 'replace_block', section_id: 'missing', block_id: 'none', content: 'gone' }],
            based_on: { memories: options.answered ?? [], mental_models: [], directives: [] },
          }
        : {
            text: 'Alice owns billing.',
            based_on: { memories: options.answered ?? [], mental_models: [], directives: [] },
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
    }),
  };
  const producer = { enqueue: vi.fn(async () => undefined) };
  const features = { unavailable: vi.fn(() => []), disabled: vi.fn(async () => []) };
  const config = { get: vi.fn(() => 0) };
  const svc = new MemoryMentalModelsService(prisma as never, reflector as never, producer as never, features as never, config as never);
  return { svc, model, operation, prisma, operationDelegate, reflector, producer, features, modelUpdates, modelWheres, operationUpdates, histories };
}

describe('MemoryMentalModelsService refresh (#1160)', () => {
  it('writes generated content, evidence and the snapshot watermark only after reflect succeeds', async () => {
    const run = fixture();
    await run.svc.execute(OP);
    expect(run.reflector.reflect).toHaveBeenCalledWith(bank, expect.objectContaining({
      query: 'Who owns billing?',
      facts: true,
      written: { before: new Date('2026-02-01T00:00:00Z') },
      mentalModelRefresh: true,
    }));
    expect(run.modelUpdates.at(-1)).toMatchObject({
      content: 'Alice owns billing.',
      lastMemorySeenAt: new Date('2026-01-15T00:00:00Z'),
      lastRefreshFailedAt: null,
      refreshedSourceQuery: 'Who owns billing?',
      refreshedScope: mentalModelScope(baseModel),
    });
    expect(run.modelWheres.at(-1)).toEqual({ bankId: 'bank-1', id: 'model-1', createdAt: baseModel.createdAt });
    expect(run.operationUpdates.at(-1)).toMatchObject({ data: { status: 'completed' } });
  });

  it('completes an empty delta window without calling the model or moving the watermark', async () => {
    const run = fixture({ latest: false, delta: true });
    await run.svc.execute(OP);
    expect(run.reflector.reflect).not.toHaveBeenCalled();
    expect(run.modelUpdates[0]).toMatchObject({ lastRefreshedAt: expect.any(Date), lastRefreshFailedAt: null });
    expect(run.modelUpdates[0]).not.toHaveProperty('content');
    expect(run.modelUpdates[0]).not.toHaveProperty('lastMemorySeenAt');
  });

  it('clears the content when a full refresh finds no memories left in scope, keeping the old content in history', async () => {
    const run = fixture({ latest: false, model: { content: 'Alice owns billing.' } });
    await run.svc.execute(OP);
    expect(run.reflector.reflect).not.toHaveBeenCalled();
    expect(run.modelUpdates.at(-1)).toMatchObject({ content: '', lastMemorySeenAt: null, lastFullRefreshedAt: expect.any(Date) });
    expect(run.histories).toMatchObject([{ previousContent: 'Alice owns billing.' }]);
  });

  it('settles without writing when the model was deleted or re-created while the refresh ran', async () => {
    const run = fixture({ gone: true, model: { content: 'Old.' } });
    await run.svc.execute(OP);
    expect(run.reflector.reflect).toHaveBeenCalled();
    expect(run.prisma.memoryMentalModel.updateMany).not.toHaveBeenCalled();
    expect(run.histories).toEqual([]);
    expect(run.operationUpdates.at(-1)).toMatchObject({ where: { id: OP, status: 'running' }, data: { status: 'cancelled' } });
  });

  it('does not start while another refresh of the same model runs, whatever else runs in the bank', async () => {
    const run = fixture();
    run.operationDelegate.findMany.mockImplementation((async (args: { where: { status: unknown } }) => args.where.status === 'running'
      ? [{ id: 'other', payload: { mental_model_id: 'model-0' } }, { id: 'same', payload: { mental_model_id: 'model-1' } }]
      : []) as never);
    await run.svc.execute(OP);
    expect(run.reflector.reflect).not.toHaveBeenCalled();
    expect(run.operationUpdates).toEqual([]);
  });

  it('drops evidence for memories deleted since, across delta refreshes', async () => {
    const run = fixture({ delta: true, previous: [{ id: 'm-deleted' }, { id: 'm-kept' }], answered: [{ id: 'm-new' }], live: ['m-kept', 'm-new'] });
    await run.svc.execute(OP);
    const stored = run.modelUpdates.at(-1)!.reflectResponse as { based_on: { memories: Evidence[] } };
    expect(stored.based_on.memories.map((memory) => memory.id)).toEqual(['m-kept', 'm-new']);
  });

  it('refreshes full and reports stale once the tag scope changed', async () => {
    const run = fixture({ delta: true, model: { tags: ['team:x'] } });
    await run.svc.execute(OP);
    expect(run.reflector.reflect).toHaveBeenCalledWith(bank, expect.objectContaining({ deltaDocument: undefined, tags: ['team:x'] }));
    run.prisma.memoryUnit.findFirst.mockResolvedValue(null as never); // no new memories: only the scope makes it stale
    const listed = await run.svc.get(bank as never, 'model-1');
    expect(listed.is_stale).toBe(true);
  });

  it('cancels a running refresh and deletes by (bank, id)', async () => {
    const run = fixture();
    run.operationDelegate.findMany.mockResolvedValue([{ id: 'running-op', payload: { mental_model_id: 'model-1' } }, { id: 'elsewhere', payload: { mental_model_id: 'model-2' } }] as never);
    await run.svc.delete(bank as never, 'model-1');
    expect(run.operationDelegate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: ['queued', 'running'] } }) }));
    expect(run.operationUpdates.at(-1)).toMatchObject({ where: { id: { in: ['running-op'] } }, data: { status: 'cancelled' } });
    expect(run.prisma.memoryMentalModel.delete).toHaveBeenCalledWith({ where: { bankId_id: { bankId: 'bank-1', id: 'model-1' } } });
  });

  it('schedules a missed cron firing, skips untriggered models and survives a failing row', async () => {
    const run = fixture();
    const due = { ...run.model, id: 'due', trigger: { refresh_cron: '0 3 * * *' }, lastRefreshedAt: new Date('2026-11-14T03:00:00Z'), bank: { createdBy: 'bank-author' } };
    const broken = { ...due, id: 'broken', workspaceId: 'ws-broken' };
    const idle = { ...run.model, id: 'idle', trigger: {} };
    run.prisma.memoryMentalModel.findMany.mockResolvedValue([broken, idle, due] as never);
    run.features.disabled.mockImplementation((async (ws: string) => { if (ws === 'ws-broken') throw new Error('boom'); return []; }) as never);
    await run.svc.sweep(Date.parse('2026-11-16T03:04:00Z'));
    expect(run.prisma.memoryUnit.findFirst).toHaveBeenCalledTimes(1);
    // Spent from the bank creator's budget, not a pseudo-user every bank shares (#1166).
    expect(run.operationDelegate.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ createdBy: 'bank-author', payload: { mental_model_id: 'due', mode: null, automatic: true } }) }));
  });

  it('reads a model as stale once a memory was deleted from its bank after its last refresh (#1166)', async () => {
    const run = fixture();
    const refreshed = { ...run.model, refreshedScope: null, lastRefreshedAt: new Date('2026-11-10T00:00:00Z'), lastMemorySeenAt: new Date('2026-11-10T00:00:00Z') };
    run.prisma.memoryMentalModel.findFirst.mockResolvedValue(refreshed as never);
    run.prisma.memoryUnit.findFirst.mockResolvedValue(null as never);
    expect((await run.svc.get(bank as never, 'model-1')).is_stale).toBe(false);
    run.prisma.memoryBank.findMany.mockResolvedValue([{ id: 'bank-1', memoriesDeletedAt: new Date('2026-11-12T00:00:00Z') }]);
    expect((await run.svc.get(bank as never, 'model-1')).is_stale).toBe(true);
  });

  it('preserves the previous document and watermark when every delta operation is rejected', async () => {
    const run = fixture({ delta: true });
    await run.svc.execute(OP);
    expect(run.modelUpdates).toHaveLength(1);
    expect(run.modelUpdates[0]).toEqual({ lastRefreshFailedAt: expect.any(Date) });
    expect(run.histories[0]).toMatchObject({
      previousContent: null,
      kind: 'refresh_failed',
      failureReason: 'delta_ops_all_skipped',
    });
    expect(run.operationUpdates.at(-1)).toMatchObject({ data: { status: 'failed' } });
  });

  it('coalesces a second manual refresh into the queued operation', async () => {
    const run = fixture();
    run.operationDelegate.findMany.mockResolvedValue([{
      id: 'held-operation',
      payload: { mental_model_id: 'model-1', mode: null },
      notBefore: null,
    }] as never);
    const first = await run.svc.refresh(bank as never, 'model-1', {}, 'u1', 'en');
    const second = await run.svc.refresh(bank as never, 'model-1', { mode: 'full' }, 'u1', 'en');
    expect(first.operation_id).toBe('held-operation');
    expect(second.operation_id).toBe(first.operation_id);
    expect(run.operationDelegate.create).not.toHaveBeenCalled();
    expect(run.operationDelegate.update).toHaveBeenLastCalledWith({
      where: { id: 'held-operation' },
      data: { payload: { mental_model_id: 'model-1', mode: 'full', automatic: false }, notBefore: null },
    });
  });
});
