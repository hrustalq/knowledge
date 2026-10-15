import { describe, expect, it, vi } from 'vitest';
import { ASSISTANT_WRITE_TOOL_NAMES } from '@knowledge/contracts';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { AssistantToolsService } from '../src/assistant/assistant.tools.js';
import { systemScope } from '../src/permissions/access-scope.js';
import type { PermissionService } from '../src/permissions/permission.service.js';
import { AssistantReadToolsService } from '../src/assistant/assistant-read-tools.service.js';
import type { AccessService } from '../src/auth/access.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { SearchService } from '../src/search/search.service.js';
import type { DocumentsService } from '../src/documents/documents.service.js';
import type { TemplatesService } from '../src/templates/templates.service.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * The chat-platform turn (issue #71, phase 0). What is pinned is what a chat
 * message cannot ask for: Ask mode whatever the workspace switch says, no tool
 * that only the web pane can draw, the bound project as a retrieval filter the
 * model cannot widen, and the `chat` feedback surface.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const PANE_TOOLS = ['ask_user', 'render_component', 'request_agent_mode'];

function readTools(search: Partial<SearchService>) {
  return new AssistantReadToolsService(
    { requireRole: vi.fn(async () => undefined) } as unknown as AccessService,
    { user: { findMany: vi.fn(async () => []) } } as unknown as PrismaService,
    search as SearchService,
    { breadcrumbsFor: vi.fn(async () => new Map()) } as unknown as DocumentsService,
    {} as TemplatesService,
    // The scope is asked before the search now (#76), so it must answer.
    { scopeFor: vi.fn(async (_p: unknown, workspaceId: string) => systemScope(workspaceId)) } as unknown as PermissionService,
  );
}

function harness() {
  const tools = Object.create(AssistantToolsService.prototype) as AssistantToolsService;
  const toolsExecute = vi.fn(async () => ({ content: '{}', ok: true, sources: [] }));
  Object.assign(tools, {
    readTools: readTools({}),
    code: { definitions: () => [] },
    execute: toolsExecute,
  });
  const svc = Object.create(AssistantService.prototype) as AssistantService;
  const messages = [
    { role: 'system', content: 'You are the researcher.' },
    { role: 'user', content: 'how do we deploy?' },
  ];
  const thread = { id: 't-1', workspaceId: WS };
  const turn = {
    agent: { tools: [], config: { webAccess: { effective: 'off' }, maxToolCalls: 8 } },
    repos: [],
    taskRepos: [],
    messages,
    labels: { label: () => 'S1', tag: () => undefined },
    collected: new Map(),
    uiBlocks: [],
    prompt: null,
    toolErrors: 0,
  };
  const openTurn = vi.fn(async () => ({ enabled: true, userMessage: { id: 'm-user' }, thread, turn, call: { userId: 'u' } }));
  const finishTurn = vi.fn(async () => ({ id: 'm-reply', content: 'Deploys go through CI [S1].' }));
  let offered: Array<{ function: { name: string } }> = [];
  let executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> = async () => undefined;
  const client = {
    runWithTools: vi.fn(
      async (
        _call: unknown,
        _messages: unknown,
        defs: Array<{ function: { name: string } }>,
        exec: (name: string, args: Record<string, unknown>) => Promise<unknown>,
      ) => {
        offered = defs;
        executeTool = exec;
        return { content: 'Deploys go through CI [S1].', trace: [] };
      },
    ),
  };
  Object.assign(svc, {
    openTurn,
    finishTurn,
    client,
    tools,
    plugins: { toolsFor: vi.fn(async () => []), isPluginTool: () => false },
    events: { publish: vi.fn(async () => undefined) },
  });
  return {
    svc,
    openTurn,
    finishTurn,
    toolsExecute,
    messages,
    offered: () => offered.map((d) => d.function.name),
    executeTool: (name: string, args: Record<string, unknown>) => executeTool(name, args),
  };
}

describe('AssistantService.runChatTurn', () => {
  it('asks in Ask mode and offers neither write tools nor pane tools', async () => {
    const h = harness();
    const res = await h.svc.runChatTurn('t-1', { content: 'how do we deploy?', agentKey: 'researcher' }, DEV_PRINCIPAL);
    expect(res).toEqual({ enabled: true, message: { id: 'm-reply', content: 'Deploys go through CI [S1].' } });
    expect(h.openTurn).toHaveBeenCalledWith(
      't-1',
      { content: 'how do we deploy?', mode: 'ask', agentKey: 'researcher' },
      DEV_PRINCIPAL,
    );
    expect(h.offered()).toContain('search_knowledge');
    for (const name of [...ASSISTANT_WRITE_TOOL_NAMES, ...PANE_TOOLS]) expect(h.offered()).not.toContain(name);
  });

  it('records the turn under the chat surface', async () => {
    const h = harness();
    await h.svc.runChatTurn('t-1', { content: 'how do we deploy?' }, DEV_PRINCIPAL);
    expect(h.finishTurn.mock.calls[0]).toContain('chat');
  });

  it('pins the bound project into every tool call and says so in the prompt', async () => {
    const h = harness();
    await h.svc.runChatTurn('t-1', { content: 'how do we deploy?', projectId: PROJECT }, DEV_PRINCIPAL);
    await h.executeTool('search_knowledge', { query: 'deploy', projectId: 'somewhere-else' });
    expect(h.toolsExecute).toHaveBeenCalledWith(
      'search_knowledge',
      { query: 'deploy', projectId: 'somewhere-else' },
      expect.objectContaining({ workspaceId: WS, projectId: PROJECT }),
    );
    expect(h.messages[0].content).toContain('bound to one project');
  });

  it('leaves the tool context unscoped without a project', async () => {
    const h = harness();
    await h.svc.runChatTurn('t-1', { content: 'how do we deploy?' }, DEV_PRINCIPAL);
    await h.executeTool('search_knowledge', { query: 'deploy' });
    const [, , ctx] = h.toolsExecute.mock.calls[0] as unknown as [string, unknown, Record<string, unknown>];
    expect(ctx).not.toHaveProperty('projectId');
    expect(h.messages[0].content).not.toContain('bound to one project');
  });

  it('returns the disabled reply without running a model', async () => {
    const h = harness();
    h.openTurn.mockResolvedValueOnce({
      enabled: false,
      userMessage: { id: 'm-user' },
      response: { enabled: false, assistantMessage: { id: 'm-off', content: 'disabled' } },
    } as never);
    const res = await h.svc.runChatTurn('t-1', { content: 'hi' }, DEV_PRINCIPAL);
    expect(res).toEqual({ enabled: false, message: { id: 'm-off', content: 'disabled' } });
  });
});

describe('search_knowledge with a pinned project', () => {
  it('filters to the project and skips the workspace-wide graph walk', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    await readTools({ search } as never).execute(
      'search_knowledge',
      { query: 'deploy' },
      { principal: DEV_PRINCIPAL, workspaceId: WS, projectId: PROJECT },
    );
    const [dto] = search.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(dto).toMatchObject({ workspaceId: WS, filters: { projectIds: [PROJECT] } });
    expect(dto).not.toHaveProperty('expandGraph');
  });

  it('expands the graph as before without one', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    await readTools({ search } as never).execute('search_knowledge', { query: 'deploy' }, { principal: DEV_PRINCIPAL, workspaceId: WS });
    const [dto] = search.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(dto).toMatchObject({ expandGraph: { depth: 1 } });
    expect(dto).not.toHaveProperty('filters');
  });
});
