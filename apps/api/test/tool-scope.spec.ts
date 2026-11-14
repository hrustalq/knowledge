import { describe, expect, it } from 'vitest';
import { scopeToAgent } from '../src/assistant/tool-scope.js';

/** #1105: a plugin tool is offered to an agent with an allowlist only when the list names it. */

const tool = (name: string) => ({ type: 'function' as const, function: { name } });
const offered = [tool('search_knowledge'), tool('web_fetch'), tool('mcp__crm__export_contacts'), tool('mcp__crm__lookup')];
const names = (list: typeof offered) => list.map((t) => t.function.name);

describe('scopeToAgent', () => {
  it('offers everything to an agent with no allowlist', () => {
    expect(names(scopeToAgent(offered, []))).toEqual(names(offered));
  });

  it('drops a plugin tool the allowlist does not name, built-in or plugin alike', () => {
    expect(names(scopeToAgent(offered, ['search_knowledge', 'mcp__crm__lookup']))).toEqual(['search_knowledge', 'mcp__crm__lookup']);
  });
});
