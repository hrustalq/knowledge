import { describe, expect, it } from 'vitest';
import { BUILT_IN_AGENT_KEYS, RUNNABLE_AGENTS, TICKET_SCOPED_AGENT_KEYS, isTriggerableAgent } from '@knowledge/contracts';
import { AGENT_RUNNERS } from '../src/agents/agent-runners.js';

/**
 * The API decides what may run from `@knowledge/contracts` and the worker runs
 * it from `AGENT_RUNNERS` (#823). Two declarations of one fact, so they are
 * pinned here: a Run button the worker cannot honour fails a second after the
 * click, with nothing to show for it.
 */
describe('agent runners', () => {
  it('has a runner for every agent a person, a schedule or a trigger may start', () => {
    const startable = BUILT_IN_AGENT_KEYS.filter((key) => isTriggerableAgent(key));
    expect([...RUNNABLE_AGENTS, ...TICKET_SCOPED_AGENT_KEYS].sort()).toEqual([...startable].sort());
    for (const key of startable) expect(AGENT_RUNNERS.has(key), key).toBe(true);
  });
});
