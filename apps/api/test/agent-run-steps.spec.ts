import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@prisma/client';
import type { BuiltInAgentKey } from '@knowledge/contracts';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import { AgentExecutor } from '../src/agents/agent.executor.js';
import { AgentProcessor } from '../src/agents/agent.processor.js';
import { AGENT_RUNNERS } from '../src/agents/agent-runners.js';
import { RunStoppedError, type AgentRunLog, type AgentRunner, type AgentServices } from '../src/agents/agent-services.js';

/** The step log and stop line of a background run (#1247). */
const WS = '11111111-1111-4111-8111-111111111111';
const run = { id: 'run-steps', workspaceId: WS, projectId: null, input: null, status: 'running' } as unknown as AgentRun;
const agent = { key: 'steps-test', name: 'Steps', description: '', instructions: '', config: { enabled: true }, missing: [] } as never;
const call = { config: { enabled: true } as never, userId: DEV_PRINCIPAL.userId, operation: 'chat' as const, locale: 'en' as const };

function executorWith(client: object) {
  const args = Array.from({ length: 28 }, () => ({}) as never);
  args[0] = { agentRun: { updateMany: vi.fn(async () => ({ count: 1 })) } } as never;
  args[3] = client as never;
  args[27] = undefined as never;
  return new AgentExecutor(...(args as []));
}

async function runWith(executor: AgentExecutor, log: AgentRunLog, body: (svc: AgentServices) => Promise<void>) {
  const key = 'steps-test' as BuiltInAgentKey;
  const runners = AGENT_RUNNERS as Map<string, AgentRunner>;
  runners.set(key, { key, run: async (svc) => (await body(svc), { summary: '', findings: [] }) });
  try {
    return await executor.run(run, agent, DEV_PRINCIPAL, async () => undefined, log);
  } finally {
    runners.delete(key);
  }
}

const logOf = (live = true): AgentRunLog & { step: ReturnType<typeof vi.fn> } => ({
  step: vi.fn(async () => undefined),
  live: vi.fn(async () => live),
  signal: new AbortController().signal,
});

describe('agent run steps', () => {
  it('logs each model round and each tool call with its arguments and pages', async () => {
    const client = {
      chat: vi.fn(),
      runWithTools: vi.fn(async (_c, _m, _t, execute, opts) => {
        await opts.onRound({ tokens: { totalTokens: 7 }, durationMs: 3 });
        await execute('read_document', { documentId: 'd1' });
        return { content: '{}', trace: [], usage: {}, cancelled: false };
      }),
    };
    const read = vi.fn(async () => ({ content: '<documents>…', ok: true, sources: [{ documentId: 'd1', title: 'Billing' }] }));
    const log = logOf();
    await runWith(executorWith(client), log, async (svc) => {
      await svc.callModel(call, agent, [{ role: 'user', content: 'go' }], read, []);
    });
    expect(read).toHaveBeenCalledOnce();
    expect(log.step.mock.calls.map(([s]) => s)).toEqual([
      { kind: 'model', name: 'chat', tokens: 7, durationMs: 3 },
      expect.objectContaining({
        kind: 'tool',
        name: 'read_document',
        args: '{"documentId":"d1"}',
        output: '<documents>…',
        ok: true,
        sources: [{ documentId: 'd1', title: 'Billing' }],
      }),
    ]);
  });

  it('stops a cancelled run before its next model call', async () => {
    const client = { chat: vi.fn(), runWithTools: vi.fn() };
    const log = logOf(false);
    await expect(
      runWith(executorWith(client), log, async (svc) => {
        await svc.client.chat(call, [{ role: 'user', content: 'go' }]);
      }),
    ).rejects.toBeInstanceOf(RunStoppedError);
    expect(client.chat).not.toHaveBeenCalled();
    expect(log.step).not.toHaveBeenCalled();
  });

  it('a step that lands nothing marks the run stopped without asking again', async () => {
    const prisma = { $executeRaw: vi.fn(async () => 0), agentRun: { count: vi.fn(async () => 1) } };
    const events = { publish: vi.fn() };
    const args = Array.from({ length: 7 }, () => ({}) as never);
    args[0] = prisma as never;
    args[5] = events as never;
    const processor = new AgentProcessor(...(args as []));
    const log = (processor as unknown as { stepLog(row: AgentRun): AgentRunLog }).stepLog(run);

    await log.step({ kind: 'tool', name: 'search_knowledge', output: 'x'.repeat(5_000) });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
    expect(events.publish).not.toHaveBeenCalled();
    expect(log.signal.aborted).toBe(true);
    expect(await log.live()).toBe(false);
    expect(prisma.agentRun.count).not.toHaveBeenCalled();
    // Once stopped, no further step is attempted.
    await log.step({ kind: 'warning', output: 'late' });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });
});
