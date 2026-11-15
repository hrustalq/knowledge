import { describe, expect, it, vi } from 'vitest';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import {
  MemoryRuntimeService,
  memoryTargets,
  personalMemoryBankId,
  projectMemoryBankId,
} from '../src/memory/memory-runtime.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';
const principal = { ...DEV_PRINCIPAL, userId: USER };
const input = {
  principal,
  workspaceId: WS,
  agentKey: 'researcher',
  projectId: PROJECT,
  userId: USER,
};

function service(opts: { editor?: boolean; recallError?: boolean } = {}) {
  const auth = {
    requireRole: vi.fn(
      async (_principal: unknown, _ws: unknown, role: string) => {
        if (role === 'editor' && opts.editor === false)
          throw new Error('read only');
      },
    ),
  };
  const features = {
    unavailable: () => [],
    require: vi.fn(async () => undefined),
  };
  const permissions = { scopeFor: vi.fn(async () => ({ userId: USER })) };
  const access = {
    visible: vi.fn(async (_scope: unknown, rows: unknown[]) => rows),
    find: vi.fn(async (_caller: unknown, bankId: string) => ({
      id: `row-${bankId}`,
      bankId,
      mission: '',
    })),
  };
  const banks = {
    ensure: vi.fn(
      async (_caller: unknown, bankId: string, defaults: unknown) => ({
        id: `row-${bankId}`,
        bankId,
        ...defaults,
      }),
    ),
  };
  const recall = {
    recallForModel: vi.fn(async () => {
      if (opts.recallError) throw new Error('vector store down');
      return {
        text: '<memories tool="agent-memory">remembered</memories>',
        results: [{ id: 'm1' }],
      };
    }),
  };
  const retain = { retain: vi.fn(async () => ({ units: 1, usage: null })) };
  const svc = new MemoryRuntimeService(
    auth as never,
    features as never,
    permissions as never,
    access as never,
    banks as never,
    recall as never,
    retain as never,
  );
  return { svc, auth, access, banks, recall, retain };
}

describe('memory runtime targets', () => {
  it('keeps agent+user and project ownership separate', () => {
    const [personal, project] = memoryTargets(input);
    expect(personal).toMatchObject({
      kind: 'personal',
      bankId: personalMemoryBankId('researcher', USER),
      agentKey: 'researcher',
      ownerId: USER,
      projectId: null,
    });
    expect(project).toMatchObject({
      kind: 'project',
      bankId: projectMemoryBankId(PROJECT),
      agentKey: null,
      ownerId: null,
      projectId: PROJECT,
    });
    expect(memoryTargets({ ...input, projectId: null })).toHaveLength(1);
  });
});

describe('MemoryRuntimeService', () => {
  it('recalls personal and project banks independently as untrusted grounding', async () => {
    const { svc, recall } = service();
    const text = await svc.ground({
      ...input,
      query: 'What are our constraints?',
    });
    expect(text).toContain('Your earlier work with this user:');
    expect(text).toContain('Earlier agent work in this project:');
    expect(recall.recallForModel).toHaveBeenCalledTimes(2);
    expect(
      recall.recallForModel.mock.calls.map((call) => call[1].maxTokens),
    ).toEqual([1024, 2048]);
  });

  it('retains one idempotent source in each bank with the right ownership and scope', async () => {
    const { svc, banks, retain } = service();
    await svc.remember({
      ...input,
      locale: 'en',
      sourceId: 'turn-1',
      sourceKind: 'assistant-turn',
      question: 'Use pnpm',
      answer: 'I will use pnpm.',
    });
    expect(banks.ensure).toHaveBeenCalledTimes(2);
    expect(banks.ensure.mock.calls[0]![2]).toMatchObject({
      agentKey: 'researcher',
      ownerId: USER,
      projectId: null,
    });
    expect(banks.ensure.mock.calls[1]![2]).toMatchObject({
      agentKey: null,
      ownerId: null,
      projectId: PROJECT,
    });
    for (const [call] of retain.retain.mock.calls) {
      expect(call.items).toHaveLength(1);
      expect(call.items[0]).toMatchObject({
        documentId: 'assistant-turn:turn-1',
        append: false,
      });
    }
    expect(
      retain.retain.mock.calls.map(
        ([call]) => call.items[0].metadata.memory_scope,
      ),
    ).toEqual(['personal', 'project']);
  });

  it('recalls for a viewer but does not retain, and a recall failure never fails the turn', async () => {
    const viewer = service({ editor: false });
    await viewer.svc.remember({
      ...input,
      locale: 'en',
      sourceId: 'turn-1',
      sourceKind: 'assistant-turn',
      question: 'q',
      answer: 'a',
    });
    expect(viewer.banks.ensure).not.toHaveBeenCalled();
    expect(viewer.retain.retain).not.toHaveBeenCalled();
    await expect(
      service({ recallError: true }).svc.ground({ ...input, query: 'q' }),
    ).resolves.toBe('');
  });
});
