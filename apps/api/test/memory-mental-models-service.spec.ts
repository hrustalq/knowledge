import { describe, expect, it, vi } from 'vitest';
import { MemoryMentalModelsService } from '../src/memory/memory-mental-models.service.js';
import { parseMentalModelDocument } from '../src/memory/memory-mental-models.js';

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
  lastRefreshedAt: null,
  lastMemorySeenAt: null,
  lastRefreshFailedAt: null,
  lastFullRefreshedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

function fixture(options: { latest?: boolean; delta?: boolean; reply?: Error } = {}) {
  const model = {
    ...baseModel,
    ...(options.delta ? {
      content: '# Owners\n\nAlice owns billing.\n',
      trigger: { mode: 'delta' },
      structuredDoc: parseMentalModelDocument('# Owners\n\nAlice owns billing.\n'),
      refreshedSourceQuery: 'Who owns billing?',
      lastMemorySeenAt: new Date('2026-01-01T00:00:00Z'),
    } : {}),
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
    memoryMentalModel: {
      findFirst: vi.fn(async () => model),
      findUnique: vi.fn(async () => model),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        modelUpdates.push(args.data);
        return model;
      }),
    },
    memoryMentalModelHistory: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => { histories.push(args.data); }),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    memoryUnit: {
      findFirst: vi.fn(async () => options.latest === false ? null : { updatedAt: new Date('2026-01-15T00:00:00Z') }),
    },
  };
  const reflector = {
    reflect: vi.fn(async () => {
      if (options.reply) throw options.reply;
      return options.delta
        ? {
            text: '{"operations":[{"op":"replace_block","section_id":"missing","block_id":"none","content":"gone"}]}',
            delta_operations: [{ op: 'replace_block', section_id: 'missing', block_id: 'none', content: 'gone' }],
            based_on: { memories: [], mental_models: [], directives: [] },
          }
        : {
            text: 'Alice owns billing.',
            based_on: { memories: [], mental_models: [], directives: [] },
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
    }),
  };
  const producer = { enqueue: vi.fn(async () => undefined) };
  const features = { unavailable: vi.fn(() => []), disabled: vi.fn(async () => []) };
  const config = { get: vi.fn(() => 0) };
  const svc = new MemoryMentalModelsService(prisma as never, reflector as never, producer as never, features as never, config as never);
  return { svc, model, operation, prisma, operationDelegate, reflector, producer, modelUpdates, operationUpdates, histories };
}

describe('MemoryMentalModelsService refresh (#1160)', () => {
  it('writes generated content, evidence and the snapshot watermark only after reflect succeeds', async () => {
    const run = fixture();
    await run.svc.execute(OP);
    expect(run.reflector.reflect).toHaveBeenCalledWith(bank, expect.objectContaining({
      query: 'Who owns billing?',
      facts: true,
      written: { before: new Date('2026-02-01T00:00:00Z') },
    }));
    expect(run.modelUpdates.at(-1)).toMatchObject({
      content: 'Alice owns billing.',
      lastMemorySeenAt: new Date('2026-01-15T00:00:00Z'),
      lastRefreshFailedAt: null,
      refreshedSourceQuery: 'Who owns billing?',
    });
    expect(run.operationUpdates.at(-1)).toMatchObject({ data: { status: 'completed' } });
  });

  it('completes an empty retrieval window without calling the model or moving the watermark', async () => {
    const run = fixture({ latest: false });
    await run.svc.execute(OP);
    expect(run.reflector.reflect).not.toHaveBeenCalled();
    expect(run.modelUpdates[0]).toMatchObject({ lastRefreshedAt: expect.any(Date), lastRefreshFailedAt: null });
    expect(run.modelUpdates[0]).not.toHaveProperty('content');
    expect(run.modelUpdates[0]).not.toHaveProperty('lastMemorySeenAt');
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
