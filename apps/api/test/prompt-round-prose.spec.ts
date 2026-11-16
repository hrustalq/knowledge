import { describe, expect, it, vi } from 'vitest';

/**
 * #1186: a model that answers in the round where it offers the Agent-mode
 * switch (or asks a form question) must not lose that answer. Only the last
 * round used to become the reply, so the closing "the button is above"
 * sentence replaced the answer it had already written.
 */

const { AssistantClient } = await import('../src/assistant/assistant.client.js');

type Round = { content: string | null; calls: string[] };

function clientReplying(rounds: Round[]) {
  const client = new AssistantClient({} as never);
  let i = 0;
  (client as unknown as { create: unknown }).create = async () => {
    const r = rounds[i++] ?? { content: 'done', calls: [] };
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: r.content,
            ...(r.calls.length
              ? { tool_calls: r.calls.map((name, n) => ({ id: `c${i}_${n}`, type: 'function', function: { name, arguments: '{}' } })) }
              : {}),
          },
        },
      ],
    };
  };
  return client;
}

const ctx = { config: { maxToolCalls: 6, model: 'fake' }, userId: 'u', operation: 'ask' } as never;
const tool = (name: string) => ({ type: 'function' as const, function: { name, parameters: { type: 'object' } } });
const tools = [tool('search_knowledge'), tool('request_agent_mode'), tool('ask_user')];
const execute = vi.fn(async () => ({ content: '{"ok":true}', ok: true }));

describe('prose written beside a prompt tool is part of the answer', () => {
  it('keeps the answer from the round that offered Agent mode, ahead of the closing sentence', async () => {
    const client = clientReplying([
      { content: null, calls: ['search_knowledge'] },
      { content: 'The freeze starts Friday 15:00 [S1].', calls: ['request_agent_mode'] },
      { content: 'The switch is above.', calls: [] },
    ]);
    const { content } = await client.runWithTools(ctx, [{ role: 'user', content: 'q' }], tools, execute);
    expect(content).toBe('The freeze starts Friday 15:00 [S1].\n\nThe switch is above.');
  });

  it('still drops narration from rounds that only did work', async () => {
    const client = clientReplying([
      { content: 'Let me search.', calls: ['search_knowledge'] },
      { content: 'Answer.', calls: [] },
    ]);
    const { content } = await client.runWithTools(ctx, [{ role: 'user', content: 'q' }], tools, execute);
    expect(content).toBe('Answer.');
  });

  it('leaves the reply unchanged when the prompt round wrote nothing', async () => {
    const client = clientReplying([
      { content: null, calls: ['ask_user'] },
      { content: 'Pick one above.', calls: [] },
    ]);
    const { content } = await client.runWithTools(ctx, [{ role: 'user', content: 'q' }], tools, execute);
    expect(content).toBe('Pick one above.');
  });
});
