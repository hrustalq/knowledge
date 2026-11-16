import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  resolveAgentMemoryPolicy,
  type AgentMemoryPolicy,
} from '@knowledge/contracts';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import { UpdateAiAgentDto } from '../src/ai/ai.dto.js';
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

function service(
  opts: {
    editor?: boolean;
    recallError?: boolean;
    memoryPolicy?: Partial<AgentMemoryPolicy>;
    policyError?: boolean;
    /** What `runtimeBank` finds: `squatted` = a row under that id that is not the runtime's. */
    bank?: 'ok' | 'squatted';
    withinProjectAudience?: boolean;
    visibleError?: boolean;
  } = {},
) {
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
  const permissions = {
    scopeFor: vi.fn(async () => ({ userId: USER })),
    audienceScope: vi.fn(async (scope: object) => ({ ...scope, clamped: true })),
  };
  const access = {
    visible: vi.fn(async (_scope: unknown, rows: unknown[]) => {
      if (opts.visibleError) throw new Error('db down');
      return rows;
    }),
    withinProjectAudience: vi.fn(async () => opts.withinProjectAudience ?? true),
  };
  const agents = {
    resolve: vi.fn(async () => {
      if (opts.policyError) throw new Error('registry unavailable');
      return { memoryPolicy: resolveAgentMemoryPolicy(opts.memoryPolicy) };
    }),
  };
  const banks = {
    runtimeBank: vi.fn(
      async (_caller: unknown, target: { bankId: string }) =>
        opts.bank === 'squatted' ? null : { id: `row-${target.bankId}`, ...target },
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
    agents as never,
    banks as never,
    recall as never,
    retain as never,
    { get: () => 0.4 } as never,
  );
  return { svc, auth, permissions, access, agents, banks, recall, retain };
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

describe('agent memory policy', () => {
  it('defaults to all and resolves independent scope overrides', () => {
    expect(resolveAgentMemoryPolicy(undefined)).toEqual({
      mode: 'all',
      personal: 'all',
      project: 'all',
    });
    expect(
      resolveAgentMemoryPolicy({ mode: 'durable', project: 'off' }),
    ).toEqual({ mode: 'durable', personal: 'durable', project: 'off' });
    expect(resolveAgentMemoryPolicy({ mode: 'invalid' })).toEqual({
      mode: 'all',
      personal: 'all',
      project: 'all',
    });
  });

  it('validates the policy DTO, including nested values', async () => {
    const valid = plainToInstance(UpdateAiAgentDto, {
      workspaceId: WS,
      memoryPolicy: { mode: 'durable', personal: 'all' },
    });
    expect(await validate(valid)).toEqual([]);
    const invalid = plainToInstance(UpdateAiAgentDto, {
      workspaceId: WS,
      memoryPolicy: { mode: 'everything' },
    });
    expect((await validate(invalid))[0]?.property).toBe('memoryPolicy');
  });
});

describe('MemoryRuntimeService', () => {
  it('recalls personal and project banks independently as untrusted grounding', async () => {
    const { svc, recall } = service();
    const { text, personal } = await svc.ground({
      ...input,
      query: 'What are our constraints?',
    });
    expect(personal).toBe(true);
    expect(text).toContain('Your earlier work with this user:');
    expect(text).toContain('Earlier agent work in this project:');
    expect(recall.recallForModel).toHaveBeenCalledTimes(2);
    expect(
      recall.recallForModel.mock.calls.map((call) => call[1].maxTokens),
    ).toEqual([1024, 2048]);
    // An unrelated memory is no grounding and must not mark the turn personal (#1187).
    expect(recall.recallForModel.mock.calls.map((call) => call[1].minScores)).toEqual([
      { semantic: 0.4 },
      { semantic: 0.4 },
    ]);
  });

  it('retains one idempotent source in each bank with the right ownership and scope', async () => {
    const { svc, banks, retain } = service();
    const turn = {
      ...input,
      sourceId: 'turn-1',
      sourceKind: 'assistant-turn' as const,
      shareWithProject: true,
      question: 'Use pnpm',
      answer: 'I will use pnpm.',
    };
    await svc.remember(turn);
    await svc.remember(turn);
    expect(banks.runtimeBank).toHaveBeenCalledTimes(4);
    expect(banks.runtimeBank.mock.calls[0]![2]).toEqual({ create: true });
    expect(banks.runtimeBank.mock.calls[0]![1]).toMatchObject({
      agentKey: 'researcher',
      ownerId: USER,
      projectId: null,
    });
    expect(banks.runtimeBank.mock.calls[1]![1]).toMatchObject({
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
      expect(call.durableOnly).toBe(false);
    }
    expect(
      retain.retain.mock.calls.map(
        ([call]) => call.items[0].metadata.memory_scope,
      ),
    ).toEqual(['personal', 'project', 'personal', 'project']);
  });

  it('durable asks extraction to drop chatter in both scopes', async () => {
    const { svc, retain } = service({ memoryPolicy: { mode: 'durable' } });
    await svc.remember({
      ...input,
      sourceId: 'turn-2',
      sourceKind: 'assistant-turn',
      shareWithProject: true,
      question: 'Thanks',
      answer: 'You are welcome.',
    });
    expect(retain.retain.mock.calls.map(([call]) => call.durableOnly)).toEqual([
      true,
      true,
    ]);
  });

  it('off writes no bank but leaves recall functional', async () => {
    const { svc, banks, retain, recall } = service({
      memoryPolicy: { mode: 'off' },
    });
    await svc.remember({
      ...input,
      sourceId: 'turn-3',
      sourceKind: 'assistant-turn',
      shareWithProject: true,
      question: 'Remember this',
      answer: 'Done.',
    });
    expect(banks.runtimeBank).not.toHaveBeenCalled();
    expect(retain.retain).not.toHaveBeenCalled();
    await svc.ground({ ...input, query: 'What do you remember?' });
    expect(recall.recallForModel).toHaveBeenCalledTimes(2);
  });

  it('applies scope overrides without moving content between banks', async () => {
    const personal = service({
      memoryPolicy: { mode: 'off', personal: 'durable' },
    });
    await personal.svc.remember({
      ...input,
      sourceId: 'turn-4',
      sourceKind: 'assistant-turn',
      shareWithProject: true,
      question: 'I prefer pnpm',
      answer: 'I will use pnpm.',
    });
    expect(personal.retain.retain).toHaveBeenCalledOnce();
    expect(personal.retain.retain.mock.calls[0]![0]).toMatchObject({
      durableOnly: true,
      items: [{ metadata: { memory_scope: 'personal' } }],
    });

    const project = service({
      memoryPolicy: { mode: 'off', project: 'all' },
    });
    await project.svc.remember({
      ...input,
      sourceId: 'run-4',
      sourceKind: 'agent-run',
      shareWithProject: true,
      question: 'Check requirements',
      answer: 'Deployments require review.',
    });
    expect(project.retain.retain).toHaveBeenCalledOnce();
    expect(project.retain.retain.mock.calls[0]![0]).toMatchObject({
      durableOnly: false,
      items: [{ metadata: { memory_scope: 'project' } }],
    });
  });

  it('recalls for a viewer but does not retain, and a recall failure never fails the turn', async () => {
    const viewer = service({
      editor: false,
      memoryPolicy: { mode: 'durable' },
    });
    await viewer.svc.remember({
      ...input,
      sourceId: 'turn-1',
      sourceKind: 'assistant-turn',
      shareWithProject: true,
      question: 'q',
      answer: 'a',
    });
    expect(viewer.banks.runtimeBank).not.toHaveBeenCalled();
    expect(viewer.retain.retain).not.toHaveBeenCalled();
    await expect(
      service({ recallError: true }).svc.ground({ ...input, query: 'q' }),
    ).resolves.toEqual({ text: '', personal: false });
  });

  it('a policy lookup failure skips retention without failing the run', async () => {
    const { svc, banks, retain } = service({ policyError: true });
    await expect(
      svc.remember({
        ...input,
        sourceId: 'run-5',
        sourceKind: 'agent-run',
        shareWithProject: true,
        question: 'q',
        answer: 'a',
      }),
    ).resolves.toBeUndefined();
    expect(banks.runtimeBank).not.toHaveBeenCalled();
    expect(retain.retain).not.toHaveBeenCalled();
  });

  const turn = {
    ...input,
    sourceId: 'turn-9',
    sourceKind: 'assistant-turn' as const,
    shareWithProject: true,
    question: 'q',
    answer: 'a',
  };
  const scopes = (retain: { retain: { mock: { calls: Array<[{ items: Array<{ metadata: { memory_scope: string } }> }]> } } }) =>
    retain.retain.mock.calls.map(([call]) => call.items[0]!.metadata.memory_scope);

  it('neither recalls from nor writes to a bank whose id is held by a row that is not the runtime’s', async () => {
    const { svc, recall, retain } = service({ bank: 'squatted' });
    await expect(svc.ground({ ...input, query: 'q' })).resolves.toEqual({ text: '', personal: false });
    expect(recall.recallForModel).not.toHaveBeenCalled();
    await svc.remember(turn);
    expect(retain.retain).not.toHaveBeenCalled();
  });

  it('for output an audience reads: no personal bank, and project banks under the clamped scope', async () => {
    const { svc, recall, retain, banks, access, permissions } = service();
    const audience = { kind: 'workspace' as const };
    const grounding = await svc.ground({ ...input, query: 'q', audience });
    expect(grounding.personal).toBe(false);
    expect(grounding.text).not.toContain('Your earlier work with this user:');
    expect(recall.recallForModel).toHaveBeenCalledOnce();
    expect(permissions.audienceScope).toHaveBeenCalledWith({ userId: USER }, audience);
    expect(access.visible.mock.calls[0]![0]).toMatchObject({ clamped: true });
    await svc.remember({ ...turn, sourceKind: 'agent-run', audience });
    expect(banks.runtimeBank.mock.calls.map((call) => (call[1] as { kind: string }).kind)).toEqual(['project', 'project']);
    expect(scopes(retain as never)).toEqual(['project']);
  });

  it('copies a turn into the project bank only when the caller vouches for it and the scope fits the project audience', async () => {
    const unvouched = service();
    await unvouched.svc.remember({ ...turn, shareWithProject: false });
    expect(scopes(unvouched.retain as never)).toEqual(['personal']);

    const wider = service({ withinProjectAudience: false });
    await wider.svc.remember(turn);
    expect(wider.access.withinProjectAudience).toHaveBeenCalledWith({ userId: USER }, PROJECT);
    expect(scopes(wider.retain as never)).toEqual(['personal']);

    const fits = service();
    await fits.svc.remember(turn);
    expect(scopes(fits.retain as never)).toEqual(['personal', 'project']);
  });

  it('never throws, whatever fails inside it', async () => {
    const { svc, retain } = service({ visibleError: true });
    await expect(svc.remember(turn)).resolves.toBeUndefined();
    expect(retain.retain).not.toHaveBeenCalled();
  });
});
