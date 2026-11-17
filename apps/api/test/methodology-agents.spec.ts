import { describe, expect, it, vi } from 'vitest';
import { meetsTier, ownedAgentKey } from '@knowledge/contracts';
import { AiConfigService } from '../src/ai/ai-config.service.js';
import { AgentRegistryService } from '../src/agents/agent-registry.service.js';
import { AiAgentsService } from '../src/ai/ai-agents.service.js';
import { MethodologyMaterializerService } from '../src/blueprints/methodology-materializer.service.js';

const BP = 'b1b2b3b4-0000-4000-8000-000000000000';

describe('model tiers (#1127)', () => {
  const model = (id: string, tier: string | null, prompt: number | null, completion: number | null) => ({
    id,
    code: id,
    tier,
    pricePromptPerMTok: prompt,
    priceCompletionPerMTok: completion,
    priceCachedPerMTok: null,
    priceCurrency: null,
  });
  function config(models: ReturnType<typeof model>[], route: string | null) {
    const svc = Object.create(AiConfigService.prototype) as AiConfigService;
    Object.assign(svc, {
      settings: async () => ({ config: { workspaceId: 'ws' }, routes: { chat: route } }),
      availableModels: async () => models,
      forModel: async (_base: unknown, id: string) => ({ model: id, modelId: id }),
    });
    return svc;
  }

  it('reads "at least": an unknown tier meets nothing', () => {
    expect(meetsTier('large', 'medium')).toBe(true);
    expect(meetsTier('small', 'medium')).toBe(false);
    expect(meetsTier(null, 'small')).toBe(false);
  });

  it('takes the routed model when it is strong enough, else the cheapest that is, never a weaker one', async () => {
    const models = [model('mini', 'small', 0.1, 0.2), model('big', 'large', 5, 15), model('bigger', 'large', 10, 30), model('mid', 'medium', 1, 2)];
    expect((await config(models, 'bigger').resolveAtLeast('ws', 'chat', 'large'))?.model).toBe('bigger');
    expect((await config(models, 'mini').resolveAtLeast('ws', 'chat', 'large'))?.model).toBe('big');
    expect((await config(models, 'mini').resolveAtLeast('ws', 'chat', 'medium'))?.model).toBe('mid');
    expect(await config([model('mini', 'small', 0.1, 0.2), model('anon', null, 0, 0)], 'mini').resolveAtLeast('ws', 'chat', 'large')).toBeNull();
  });

  it('resolves an agent without a tier exactly as before; with one, tiered or flagged', async () => {
    const row = { key: 'modeller-b1b2b3b4', minTier: null as string | null, modelId: null as string | null, blueprintId: BP };
    const aiConfig = {
      resolveFor: vi.fn(async () => ({ model: 'routed', enabled: true, capabilities: null })),
      resolveAtLeast: vi.fn(async (): Promise<unknown> => ({ model: 'large-one', enabled: true, capabilities: null })),
    };
    const prisma = { aiAgent: { findMany: vi.fn(async () => [row]) } };
    const registry = () => new AgentRegistryService(prisma as never, aiConfig as never);

    let agent = await registry().resolve('ws', row.key);
    expect(agent.config.model).toBe('routed');
    expect(aiConfig.resolveAtLeast).not.toHaveBeenCalled();
    expect(agent).toMatchObject({ minTier: null, tierUnmet: false, blueprintId: BP });

    row.minTier = 'large';
    agent = await registry().resolve('ws', row.key);
    expect(agent.config.model).toBe('large-one');
    expect(agent.tierUnmet).toBe(false);

    aiConfig.resolveAtLeast.mockResolvedValueOnce(null);
    agent = await registry().resolve('ws', row.key);
    expect(agent.config.model).toBe('routed');
    expect(agent.tierUnmet).toBe(true);

    // A pin is a person's choice: the tier does not override it.
    aiConfig.resolveAtLeast.mockClear();
    row.modelId = 'pinned';
    agent = await registry().resolve('ws', row.key);
    expect(aiConfig.resolveAtLeast).not.toHaveBeenCalled();
    expect(agent.tierUnmet).toBe(false);
  });
});

describe('methodology agents (#1127)', () => {
  it('keys a methodology agent apart from a workspace agent; a built-in key stays itself', () => {
    expect(ownedAgentKey('modeller', BP)).toBe('modeller-b1b2b3b4');
    expect(ownedAgentKey('reviewer', BP)).toBe('reviewer');
  });

  function setup() {
    const rows: Record<string, unknown>[] = [{ id: 'mine', workspaceId: 'ws', key: 'modeller', blueprintId: null, enabled: true }];
    const prisma = {
      withTransaction: async <T>(fn: () => Promise<T>) => fn(),
      onCommit: (fn: () => Promise<unknown>) => void fn(),
      pageTemplate: { findMany: async () => [] },
      workflowDefinition: { findMany: async () => [] },
      aiSkill: { findFirst: async () => null },
      glossaryTerm: { findMany: async () => [] },
      aiAgent: {
        findMany: async ({ where }: { where: { blueprintId: string } }) => rows.filter((r) => r.blueprintId === where.blueprintId),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => rows.push({ id: `a${rows.length}`, enabled: true, modelId: null, ...data })),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
      },
    };
    const registry = { invalidate: vi.fn() };
    const service = new MethodologyMaterializerService(prisma as never, {} as never, {} as never, {} as never, registry as never);
    return { service, rows, registry, prisma };
  }
  const blueprint = (instructions = 'Model the domain.') => ({
    name: { en: 'M' },
    tree: [],
    agents: [{ key: 'modeller', name: 'Modeller', instructions, minTier: 'large' as const }],
  });

  it('writes its agents beside a workspace agent of the same key, keeps the admin’s switch and pin, and refreshes the cache', async () => {
    const { service, rows, registry } = setup();
    expect(await service.materialize('ws', BP, blueprint())).toBe(1);
    expect(rows.map((r) => [r.key, r.blueprintId])).toEqual([['modeller', null], ['modeller-b1b2b3b4', BP]]);
    expect(registry.invalidate).toHaveBeenCalledWith('ws');
    expect(await service.materialize('ws', BP, blueprint())).toBe(0);

    Object.assign(rows[1]!, { enabled: false, modelId: 'pinned' });
    expect(await service.materialize('ws', BP, blueprint('Model the domain, rules first.'))).toBe(1);
    expect(rows[1]).toMatchObject({ instructions: 'Model the domain, rules first.', enabled: false, modelId: 'pinned', minTier: 'large' });

    rows[1]!.enabled = true;
    expect(await service.materialize('ws', BP, { ...blueprint(), agents: [] })).toBe(1);
    expect(rows[1]!.enabled).toBe(false);
    expect(rows[0]!.enabled).toBe(true);
  });

  it('lets an admin only switch or pin a methodology agent, and never delete it', async () => {
    const row = { workspaceId: 'ws', key: 'modeller-b1b2b3b4', blueprintId: BP };
    const prisma = {
      aiAgent: {
        findUnique: vi.fn(async () => row),
        count: vi.fn(async () => 1),
        deleteMany: vi.fn(),
        upsert: vi.fn(async () => row),
      },
    };
    const service = new AiAgentsService(prisma as never, { invalidate: vi.fn() } as never, { toolsFor: async () => [] } as never, { assertInWorkspace: async () => undefined } as never);
    vi.spyOn(service, 'get').mockResolvedValue({} as never);
    await expect(service.update('ws', row.key, { instructions: 'mine now' } as never)).rejects.toThrow(/agentFromMethodology/);
    await expect(service.update('ws', row.key, { enabled: false, modelId: null } as never)).resolves.toBeDefined();
    await expect(service.remove('ws', row.key)).rejects.toThrow(/agentFromMethodology/);
    expect(prisma.aiAgent.deleteMany).not.toHaveBeenCalled();
  });
});
