import { describe, expect, it, vi } from 'vitest';
import { AiAgentsService } from '../src/ai/ai-agents.service.js';
import { AgentRegistryService } from '../src/agents/agent-registry.service.js';

describe('agent choices (#1290)', () => {
  it('keeps both scopes byte-identical without resolving providers', async () => {
    const rows = [
      { key: 'researcher', name: 'Research override', description: null, enabled: true },
      { key: 'author', name: null, description: 'Author override', enabled: false },
      { key: 'router', name: null, description: null, enabled: true },
      { key: 'helper', name: 'Helper', description: 'Custom agent', enabled: true },
      { key: 'sleeper', name: 'Sleeper', description: 'Disabled custom agent', enabled: false },
    ];
    const prisma = { aiAgent: { findMany: vi.fn(async () => rows) } };
    const aiConfig = {
      resolveFor: vi.fn(async () => ({ model: 'unused', enabled: true, capabilities: [] })),
      resolveAtLeast: vi.fn(),
    };
    const registry = new AgentRegistryService(prisma as never, aiConfig as never);
    const service = new AiAgentsService(prisma as never, registry, {} as never, {} as never);

    const all = await service.choices('ws', 'all');
    const offered = await service.choices('ws');

    expect(prisma.aiAgent.findMany).toHaveBeenCalledTimes(1);
    expect(aiConfig.resolveFor).not.toHaveBeenCalled();
    expect(aiConfig.resolveAtLeast).not.toHaveBeenCalled();

    const resolved = await registry.list('ws');
    const expected = (scope: 'offered' | 'all') =>
      resolved
        .filter(
          (agent) =>
            scope === 'all' ||
            (agent.enabled && agent.surfaces.includes('interactive') && agent.key !== 'router'),
        )
        .map((agent) => ({ key: agent.key, name: agent.name, description: agent.description }));
    expect(JSON.stringify(all)).toBe(JSON.stringify(expected('all')));
    expect(JSON.stringify(offered)).toBe(JSON.stringify(expected('offered')));
  });
});
