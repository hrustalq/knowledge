import { describe, expect, it, vi } from 'vitest';

/**
 * The harness runs only what it offered (GHSA-q976-7233-2h43). Mode, the
 * per-agent allowlist and the pane-only tools are applied when the tool list
 * is built; a provider is free to return any name, so a call outside that
 * round's list is answered with an error and never executed.
 */

const { AssistantClient } = await import('../src/assistant/assistant.client.js');

type Round = { name: string; arguments?: string }[];

function clientReplying(rounds: Round[]) {
  const client = new AssistantClient({} as never);
  const seen: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: unknown }> }> = [];
  let i = 0;
  (client as unknown as { create: unknown }).create = async (_ctx: unknown, params: (typeof seen)[number]) => {
    seen.push(params);
    const calls = rounds[i++] ?? [];
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: calls.length ? null : 'done',
            ...(calls.length
              ? {
                  tool_calls: calls.map((c, n) => ({
                    id: `call_${i}_${n}`,
                    type: 'function',
                    function: { name: c.name, arguments: c.arguments ?? '{}' },
                  })),
                }
              : {}),
          },
        },
      ],
    };
  };
  return { client, seen };
}

const ctx = { config: { maxToolCalls: 6, model: 'fake' }, userId: 'u', operation: 'ask' } as never;
const tool = (name: string) => ({ type: 'function' as const, function: { name, parameters: { type: 'object' } } });

describe('AssistantClient runs only offered tools', () => {
  it('answers an unoffered write tool with an error and never executes it', async () => {
    const { client, seen } = clientReplying([[{ name: 'create_document', arguments: '{"title":"x"}' }], []]);
    const execute = vi.fn(async () => ({ content: '{"ok":true}', ok: true }));

    const { content, trace } = await client.runWithTools(ctx, [{ role: 'user', content: 'hi' }], [tool('search_documents')], execute);

    expect(execute).not.toHaveBeenCalled();
    expect(content).toBe('done');
    expect(trace).toEqual([{ tool: 'create_document', arguments: '{"title":"x"}', ok: false }]);
    const reply = seen[1]!.messages.find((m) => m.role === 'tool');
    expect(String(reply?.content)).toContain('not available');
  });

  it('still runs an offered tool in the same round', async () => {
    const { client } = clientReplying([[{ name: 'search_documents' }, { name: 'propose_update' }], []]);
    const execute = vi.fn(async () => ({ content: '[]', ok: true }));

    await client.runWithTools(ctx, [{ role: 'user', content: 'hi' }], [tool('search_documents')], execute);

    expect(execute.mock.calls.map((c) => c[0])).toEqual(['search_documents']);
  });

  it('does not run a free tool that was not offered', async () => {
    const tight = { config: { maxToolCalls: 0, model: 'fake' }, userId: 'u', operation: 'ask' } as never;
    // edit_draft costs no budget, but this caller never offered it (it is pane-only).
    const { client } = clientReplying([[{ name: 'edit_draft' }], []]);
    const execute = vi.fn(async () => ({ content: '[]', ok: true }));

    await client.runWithTools(tight, [{ role: 'user', content: 'hi' }], [tool('search_documents')], execute);

    expect(execute).not.toHaveBeenCalled();
  });
});

const { AssistantToolsService } = await import('../src/assistant/assistant.tools.js');

describe('AssistantToolsService.execute holds write tools to Agent mode', () => {
  const access = { requireRole: vi.fn(async () => undefined) };
  const documents = { createDocument: vi.fn(async () => ({ id: 'd' })) };
  const tasks = { execute: vi.fn(async () => ({ content: '{}', ok: true, sources: [] })) };
  const service = new AssistantToolsService(
    access as never, {} as never, {} as never, documents as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, tasks as never, {} as never, {} as never,
  );
  const principal = { userId: 'u', isAdmin: false } as never;

  it.each([undefined, 'ask'] as const)('refuses a write tool when mode is %s', async (mode) => {
    const result = await service.execute('task_create', { title: 'x' }, { principal, workspaceId: 'w', ...(mode ? { mode } : {}) });
    expect(result.ok).toBe(false);
    expect(result.content).toContain('Agent mode');
    expect(tasks.execute).not.toHaveBeenCalled();
  });

  it('runs a write tool in Agent mode', async () => {
    await service.execute('task_create', { title: 'x' }, { principal, workspaceId: 'w', mode: 'agent' });
    expect(tasks.execute).toHaveBeenCalledTimes(1);
  });
});
