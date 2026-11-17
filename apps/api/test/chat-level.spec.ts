import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { BlueprintLevel } from '@knowledge/contracts';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { AssistantReadToolsService } from '../src/assistant/assistant-read-tools.service.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * The chat's methodology level (#1128). What is pinned:
 * 1. A turn without a level builds the prompt it built before the level existed.
 * 2. A level is valid only against the grounding page's project methodology; a named
 *    one that is not is a 400, a remembered one that no longer is drops quietly.
 * 3. The level's agent is a default: a pick beats it, and Ask mode stays the ceiling.
 * 4. The level reaches search as the prior, from the turn, never from tool arguments.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const BLUEPRINT = 'be27393b-0000-4000-8000-000000000000';
const RULES: BlueprintLevel = {
  key: 'rules',
  name: { en: 'L2 Rules', ru: 'L2 Правила' },
  templateRefs: ['rule'],
  agentKey: 'modeller',
  guidance: { en: 'State each rule as an invariant.' },
};

function service(opts: { blueprintId?: string | null; levels?: BlueprintLevel[] } = {}) {
  const svc = Object.create(AssistantService.prototype) as AssistantService;
  const blueprintId = opts.blueprintId === undefined ? BLUEPRINT : opts.blueprintId;
  const threadUpdate = vi.fn(async () => ({}));
  Object.assign(svc, {
    permissions: { scopeFor: vi.fn(async () => systemScope(WS)) },
    prisma: {
      document: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === PAGE ? { id: PAGE, workspaceId: WS, title: 'Billing', projectId: 'p-1', path: `/${PAGE}/`, restrictedBy: [] } : null)) },
      project: {
        findUnique: vi.fn(async () => ({ blueprintId })),
        findMany: vi.fn(async () => (blueprintId ? [{ id: 'p-1', blueprintId }] : [])),
      },
      projectBlueprint: { findMany: vi.fn(async () => [{ id: BLUEPRINT, builtInKey: null, versions: [{ blueprint: { levels: opts.levels ?? [RULES] } }] }]) },
      assistantThread: { update: threadUpdate },
    },
    documents: { getContent: vi.fn(async () => ({ markdown: 'Invoices are monthly.' })), breadcrumbsFor: vi.fn(async () => new Map()) },
    code: { repositories: vi.fn(async () => []) },
    tasks: { repositories: vi.fn(async () => []) },
    tools: { chatAvailable: vi.fn(async () => false) },
    skills: { forTurn: vi.fn(async () => []), renderPrompt: () => '' },
    learnings: { promptFor: vi.fn(async () => ({ prompt: '' })) },
    threads: { recentHistory: vi.fn(async () => []) },
  });
  const call = svc as unknown as {
    turnLevel: (thread: unknown, dto: unknown, principal: unknown) => Promise<{ level: BlueprintLevel; blueprintId: string } | null>;
    prepareTurn: (...a: unknown[]) => Promise<{ messages: Array<{ content: string }>; level?: string }>;
    resolveTurnAgent: (...a: unknown[]) => Promise<{ key: string }>;
  };
  return { svc, call, threadUpdate };
}

const thread = (over: Record<string, unknown> = {}) => ({ id: 't-1', workspaceId: WS, documentId: PAGE, level: null, modelId: null, ...over });
const agent = { instructions: 'You help.', config: { webAccess: { effective: 'off' } }, skillIds: [], key: 'researcher' };

describe('the prompt with and without a level', () => {
  it('is unchanged without a level', async () => {
    const { call } = service();
    const before = await call.prepareTurn(thread(), { content: 'What is a rule?' }, 'm-1', agent, 'ask', DEV_PRINCIPAL);
    const now = await call.prepareTurn(thread(), { content: 'What is a rule?' }, 'm-1', agent, 'ask', DEV_PRINCIPAL, undefined, true, null);
    expect(now.messages).toEqual(before.messages);
    expect(now).not.toHaveProperty('level');
    expect(now.messages[0]!.content).not.toContain('works at the level');
  });

  it("puts the level's guidance right after the agent's instructions", async () => {
    const { call } = service();
    const turn = await call.prepareTurn(thread(), { content: 'What is a rule?' }, 'm-1', agent, 'ask', DEV_PRINCIPAL, undefined, true, {
      level: RULES,
      blueprintId: BLUEPRINT,
    });
    expect(turn.messages[0]!.content.startsWith('You help.\n\nThis conversation works at the level "L2 Rules" of the project\'s methodology.\nState each rule as an invariant.')).toBe(true);
    expect(turn.level).toBe('rules');
  });
});

describe('turnLevel', () => {
  it('reads nothing when neither the message nor the thread names a level', async () => {
    const { svc, call } = service();
    expect(await call.turnLevel(thread(), { content: 'hi' }, DEV_PRINCIPAL)).toBeNull();
    expect((svc as unknown as { permissions: { scopeFor: ReturnType<typeof vi.fn> } }).permissions.scopeFor).not.toHaveBeenCalled();
  });

  it('refuses a level with no grounding page', async () => {
    const { call } = service();
    await expect(call.turnLevel(thread({ documentId: null }), { content: 'hi', level: 'rules' }, DEV_PRINCIPAL)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a level the page's methodology does not declare, and a project without one", async () => {
    await expect(service().call.turnLevel(thread(), { content: 'hi', level: 'code' }, DEV_PRINCIPAL)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service({ blueprintId: null }).call.turnLevel(thread(), { content: 'hi', level: 'rules' }, DEV_PRINCIPAL)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('keeps a named level on the thread and returns it', async () => {
    const { call, threadUpdate } = service();
    const found = await call.turnLevel(thread(), { content: 'hi', level: 'rules' }, DEV_PRINCIPAL);
    expect(found).toEqual({ level: RULES, blueprintId: BLUEPRINT });
    expect(threadUpdate).toHaveBeenCalledWith({ where: { id: 't-1' }, data: { level: 'rules' } });
  });

  it("uses the thread's level when the message names none, and drops a stale one quietly", async () => {
    const { call, threadUpdate } = service();
    expect(await call.turnLevel(thread({ level: 'rules' }), { content: 'hi' }, DEV_PRINCIPAL)).toEqual({ level: RULES, blueprintId: BLUEPRINT });
    expect(await call.turnLevel(thread({ level: 'gone' }), { content: 'hi' }, DEV_PRINCIPAL)).toBeNull();
    expect(threadUpdate).not.toHaveBeenCalled();
  });

  it('clears the thread with null', async () => {
    const { call, threadUpdate } = service();
    expect(await call.turnLevel(thread({ level: 'rules' }), { content: 'hi', level: null }, DEV_PRINCIPAL)).toBeNull();
    expect(threadUpdate).toHaveBeenCalledWith({ where: { id: 't-1' }, data: { level: null } });
  });
});

describe("the level's agent", () => {
  const agents = (tools: string[] = ['search_knowledge']) => ({
    resolve: vi.fn(async (_ws: string, key: string) => ({
      key,
      enabled: true,
      builtIn: key === 'researcher' || key === 'author',
      surfaces: ['interactive'],
      tools: key === `modeller-${BLUEPRINT.slice(0, 8)}` ? tools : [],
      config: {},
    })),
  });
  function picker(tools?: string[]) {
    const { svc, call } = service();
    Object.assign(svc, { agents: agents(tools), aiConfig: { chatPin: vi.fn(async () => undefined) } });
    return call;
  }
  const level = { level: RULES, blueprintId: BLUEPRINT };

  it('is the default when the message picks no agent', async () => {
    expect((await picker().resolveTurnAgent(thread(), { content: 'hi' }, 'ask', level)).key).toBe('modeller-be27393b');
    expect((await picker().resolveTurnAgent(thread(), { content: 'hi', agentKey: '' }, 'ask', level)).key).toBe('modeller-be27393b');
  });

  it('gives way to an explicit pick', async () => {
    expect((await picker().resolveTurnAgent(thread(), { content: 'hi', agentKey: 'researcher' }, 'ask', level)).key).toBe('researcher');
  });

  it('never brings a write tool into Ask mode', async () => {
    expect((await picker(['propose_update']).resolveTurnAgent(thread(), { content: 'hi' }, 'ask', level)).key).toBe('researcher');
    expect((await picker(['propose_update']).resolveTurnAgent(thread(), { content: 'hi' }, 'agent', level)).key).toBe('modeller-be27393b');
  });
});

describe('search_knowledge at a level', () => {
  it('passes the turn level to search as the prior', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const tools = new AssistantReadToolsService(
      { requireRole: vi.fn(async () => undefined) } as never,
      { user: { findMany: vi.fn(async () => []) } } as never,
      { search } as never,
      { breadcrumbsFor: vi.fn(async () => new Map()) } as never,
      {} as never,
      { scopeFor: vi.fn(async () => systemScope(WS)) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await tools.execute('search_knowledge', { query: 'rules', level: 'code' }, { principal: DEV_PRINCIPAL, workspaceId: WS, level: 'rules' });
    const [dto] = search.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(dto).toMatchObject({ level: 'rules' });
  });
});
