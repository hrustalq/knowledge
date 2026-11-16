import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import type { BuiltInAgentKey } from '@knowledge/contracts';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import { AgentExecutor } from '../src/agents/agent.executor.js';
import { AGENT_RUNNERS } from '../src/agents/agent-runners.js';

const WS = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';

describe('background agent memory', () => {
  it('grounds the shared model helper and retains the completed run', async () => {
    const client = {
      runWithTools: vi.fn(async () => ({
        content: '{"ok":true}',
        trace: [],
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          estimated: false,
        },
      })),
      chat: vi.fn(),
    };
    const memory = {
      ground: vi.fn(async () => ({
        text: '<memories tool="agent-memory">Use pnpm.</memories>',
        personal: false,
      })),
      remember: vi.fn(async () => undefined),
    };
    const prisma = {
      agentRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const args = Array.from({ length: 28 }, () => ({}) as never);
    args[0] = prisma as never;
    args[3] = client as never;
    args[27] = memory as never;
    const executor = new AgentExecutor(...(args as []));
    const key = 'memory-test' as BuiltInAgentKey;
    const previous = AGENT_RUNNERS.get(key);
    AGENT_RUNNERS.set(key, {
      key,
      run: async (svc) => {
        await svc.callModel(
          {
            config: { enabled: true } as never,
            userId: USER,
            operation: 'chat',
            locale: 'en',
          },
          { missing: [], config: {} } as never,
          [{ role: 'user', content: 'Check the project constraints.' }],
          vi.fn(),
          [],
        );
        return { summary: 'Requirements checked.', findings: [] };
      },
    });
    const run = {
      id: 'run-memory',
      workspaceId: WS,
      projectId: PROJECT,
      input: { note: 'Check constraints' },
      status: 'running',
    } as unknown as AgentRun;
    const agent = {
      key,
      name: 'Memory test',
      description: '',
      instructions: '',
      config: { enabled: true },
      missing: [],
    } as never;
    const principal = { ...DEV_PRINCIPAL, userId: USER, locale: 'en' as const };
    try {
      await executor.run(run, agent, principal, vi.fn());
    } finally {
      if (previous) AGENT_RUNNERS.set(key, previous);
      else AGENT_RUNNERS.delete(key);
    }

    const [, messages] = client.runWithTools.mock.calls[0]! as unknown as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(messages.at(-1)!.content).toContain(
      '<memories tool="agent-memory">Use pnpm.</memories>',
    );
    expect(messages.at(-1)!.content).toContain(
      'Check the project constraints.',
    );
    expect(memory.ground).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        agentKey: key,
        projectId: PROJECT,
        userId: USER,
        query: 'Extra instructions: Check constraints\n\n',
        audience: { kind: 'workspace' },
      }),
    );
    expect(memory.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'run-memory',
        sourceKind: 'agent-run',
        answer: 'Requirements checked.',
        audience: { kind: 'workspace' },
        shareWithProject: true,
      }),
    );
  });

  it('does not retain a failed run', async () => {
    const memory = {
      ground: vi.fn(async () => ({ text: '', personal: false })),
      remember: vi.fn(async () => undefined),
    };
    const prisma = {
      agentRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const args = Array.from({ length: 28 }, () => ({}) as never);
    args[0] = prisma as never;
    args[27] = memory as never;
    const executor = new AgentExecutor(...(args as []));
    const key = 'failed-memory-test' as BuiltInAgentKey;
    const previous = AGENT_RUNNERS.get(key);
    AGENT_RUNNERS.set(key, {
      key,
      run: async () => {
        throw new Error('runner failed');
      },
    });
    const run = {
      id: 'run-failed',
      workspaceId: WS,
      projectId: PROJECT,
      input: {},
      status: 'running',
    } as unknown as AgentRun;
    const agent = {
      key,
      name: 'Failed memory test',
      description: '',
      instructions: '',
      config: { enabled: true },
      missing: [],
    } as never;
    try {
      await expect(
        executor.run(
          run,
          agent,
          { ...DEV_PRINCIPAL, userId: USER, locale: 'en' },
          vi.fn(),
        ),
      ).rejects.toThrow('runner failed');
    } finally {
      if (previous) AGENT_RUNNERS.set(key, previous);
      else AGENT_RUNNERS.delete(key);
    }
    expect(memory.remember).not.toHaveBeenCalled();
  });

  /** Runs `runner` as a one-off agent and reports what memory was asked. */
  async function runWith(
    runner: Parameters<typeof AGENT_RUNNERS.set>[1]['run'],
    over: { input?: unknown; subjectKey?: string | null; remember?: () => Promise<void> } = {},
  ) {
    const memory = {
      ground: vi.fn(async () => ({ text: 'memo', personal: false })),
      remember: vi.fn(over.remember ?? (async () => undefined)),
    };
    const client = {
      runWithTools: vi.fn(async () => ({ content: '{}', trace: [], usage: {} })),
      chat: vi.fn(async () => '{}'),
    };
    const args = Array.from({ length: 28 }, () => ({}) as never);
    args[0] = { agentRun: { updateMany: vi.fn(async () => ({ count: 1 })) } } as never;
    args[3] = client as never;
    args[27] = memory as never;
    const executor = new AgentExecutor(...(args as []));
    const key = 'memory-lazy-test' as BuiltInAgentKey;
    AGENT_RUNNERS.set(key, { key, run: runner });
    try {
      const result = await executor.run(
        { id: 'run-lazy', workspaceId: WS, projectId: PROJECT, subjectKey: over.subjectKey ?? null, input: over.input ?? { note: 'Check' }, status: 'running' } as unknown as AgentRun,
        { key, name: 'Lazy', description: 'A constant description', instructions: '', config: { enabled: true }, missing: [] } as never,
        { ...DEV_PRINCIPAL, userId: USER, locale: 'en' },
        vi.fn(),
      );
      return { memory, client, result };
    } finally {
      AGENT_RUNNERS.delete(key);
    }
  }
  const viaCallModel: Parameters<typeof AGENT_RUNNERS.set>[1]['run'] = async (svc) => {
    await svc.callModel({ config: { enabled: true } as never, userId: USER, operation: 'chat', locale: 'en' }, { missing: [], config: {} } as never, [{ role: 'user', content: 'x' }], vi.fn(), []);
    await svc.callModel({ config: { enabled: true } as never, userId: USER, operation: 'chat', locale: 'en' }, { missing: [], config: {} } as never, [{ role: 'user', content: 'y' }], vi.fn(), []);
    return { summary: 'done', findings: [] };
  };

  it('recalls once, and only for a runner that goes through callModel', async () => {
    expect((await runWith(viaCallModel)).memory.ground).toHaveBeenCalledOnce();
    const direct = await runWith(async (svc) => {
      await svc.client.chat({} as never, [{ role: 'user', content: 'x' }], { json: true });
      return { summary: 'done', findings: [] };
    });
    expect(direct.memory.ground).not.toHaveBeenCalled();
    expect(direct.memory.remember).toHaveBeenCalledOnce();
  });

  it('does not recall on a constant when the run has no brief', async () => {
    const { memory } = await runWith(viaCallModel, { input: {}, subjectKey: 'doc:x' });
    expect(memory.ground).not.toHaveBeenCalled();
    expect(memory.remember).toHaveBeenCalledWith(expect.objectContaining({ question: 'doc:x' }));
  });

  it('settles the run without waiting on retention, and never shares a private run with the project', async () => {
    const { result, memory } = await runWith(viaCallModel, {
      subjectKey: 'memo:m1',
      remember: () => new Promise<void>(() => undefined),
    });
    expect(result.summary).toBe('done');
    expect(memory.remember).toHaveBeenCalledWith(expect.objectContaining({ shareWithProject: false }));
  });
});
