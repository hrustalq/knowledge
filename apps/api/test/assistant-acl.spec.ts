import { describe, expect, it, vi } from 'vitest';
import { AssistantReadToolsService } from '../src/assistant/assistant-read-tools.service.js';
import { AssistantToolsService } from '../src/assistant/assistant.tools.js';
import { NotFoundException } from '@nestjs/common';
import { AssistantThreadsService } from '../src/assistant/assistant-threads.service.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

/**
 * The assistant's tools under page permissions (issue #76, phase 4).
 *
 * What is pinned:
 * 1. **A page the caller cannot open is "not found"** to the model — the same
 *    words as a page that does not exist, and its content is never read.
 * 2. **Visibility is asked on every call.** A grant revoked between two calls
 *    of one turn holds from the second.
 * 3. **The audience reaches the scope.** A run whose output others read (a
 *    group chat, an agent's findings) has every read clamped.
 * 4. **Edit tools need edit on the page**, not just the editor role.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PAGE = '22222222-2222-4222-8222-222222222222';
const ctx = { principal: DEV_PRINCIPAL, workspaceId: WS, mode: 'agent' as const };
const owner = { workspaceId: WS, bypass: false } as unknown as AccessScope;
const clamped = { workspaceId: WS, bypass: false, clamped: true } as unknown as AccessScope;

function readTools(visible: () => boolean) {
  const permissions = {
    scopeFor: vi.fn(async () => owner),
    audienceScope: vi.fn(async () => clamped),
    visibleDocumentIds: vi.fn(async (_s: AccessScope, ids: string[]) => new Set(visible() ? ids : [])),
    auditBypassRead: vi.fn(async () => undefined),
  };
  const documents = {
    getContent: vi.fn(async () => ({ revisionId: 'r-1', markdown: '# Salaries', frontmatter: null })),
    breadcrumbsFor: vi.fn(async () => new Map()),
  };
  const prisma = { document: { findUnique: vi.fn(async () => ({ id: PAGE, workspaceId: WS, title: 'Salaries' })) } };
  const tools = new AssistantReadToolsService(
    { requireRole: vi.fn(async () => undefined) } as never,
    prisma as never,
    {} as never,
    documents as never,
    {} as never,
    permissions as never,
    {} as never,
    { view: vi.fn(async () => undefined) } as never,
  );
  return { tools, permissions, documents };
}

describe('assistant read tools', () => {
  it('answers "not found" for a page the caller cannot open, without reading it', async () => {
    const { tools, documents } = readTools(() => false);
    const res = await tools.execute('read_document', { documentId: PAGE }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain(`Document ${PAGE} not found in this workspace`);
    expect(res.content).not.toContain('Salaries');
    expect(documents.getContent).not.toHaveBeenCalled();

    for (const name of ['explore_document_graph', 'list_relations']) {
      const other = await tools.execute(name, { documentId: PAGE }, ctx);
      expect(other.ok, name).toBe(false);
    }
  });

  it('asks again on every call, so a revocation mid-turn holds from the next one', async () => {
    let open = true;
    const { tools, permissions } = readTools(() => open);
    expect((await tools.execute('read_document', { documentId: PAGE }, ctx)).ok).toBe(true);
    open = false;
    expect((await tools.execute('read_document', { documentId: PAGE }, ctx)).ok).toBe(false);
    expect(permissions.scopeFor).toHaveBeenCalledTimes(2);
  });

  it('clamps every read to the run’s audience when it has one', async () => {
    const { tools, permissions } = readTools(() => true);
    await tools.execute('read_document', { documentId: PAGE }, { ...ctx, audience: { kind: 'workspace' } });
    expect(permissions.audienceScope).toHaveBeenCalledWith(owner, { kind: 'workspace' });
    expect(permissions.visibleDocumentIds).toHaveBeenCalledWith(clamped, [PAGE]);

    permissions.audienceScope.mockClear();
    await tools.execute('read_document', { documentId: PAGE }, ctx);
    expect(permissions.audienceScope).not.toHaveBeenCalled();
  });
});

describe('assistant write tools', () => {
  function writeTools(level: string) {
    const svc = Object.create(AssistantToolsService.prototype) as AssistantToolsService;
    const documents = { createBranch: vi.fn() };
    Object.assign(svc, {
      access: { requireRole: vi.fn(async () => undefined) },
      prisma: { document: { findUnique: vi.fn(async () => ({ id: PAGE, workspaceId: WS, title: 'Salaries' })) } },
      permissions: { scopeFor: vi.fn(async () => owner), levelFor: vi.fn(async () => level) },
      documents,
      logger: { warn: vi.fn() },
    });
    return { svc, documents };
  }

  it('refuses propose_update on a page the caller can read but not edit', async () => {
    const { svc, documents } = writeTools('view');
    const res = await svc.execute('propose_update', { documentId: PAGE, title: 't', markdown: 'x' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('but not edit it');
    expect(documents.createBranch).not.toHaveBeenCalled();
  });

  it('treats a page the caller cannot open as missing', async () => {
    const { svc } = writeTools('none');
    const res = await svc.execute('edit_relations', { documentId: PAGE, add: [] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('not found in this workspace');
    expect(res.content).not.toContain('Salaries');
  });
});

/** #772: a chat thread is its asker's, on every route that takes one and in the list. */
describe('a chat thread belongs to its asker', () => {
  const ALICE = '33333333-3333-4333-8333-333333333333';
  const session = (userId: string) => ({ userId, mode: 'session', isAdmin: false }) as never;
  const THREAD = '44444444-4444-4444-8444-444444444444';
  const MESSAGE = '55555555-5555-4555-8555-555555555555';

  function access() {
    const prisma = {
      assistantThread: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === THREAD ? { createdBy: ALICE } : null)) },
      assistantMessage: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === MESSAGE ? { thread: { createdBy: ALICE } } : null)) },
    };
    return new AccessService(prisma as never, {} as never);
  }

  it('lets the asker through', async () => {
    await expect(access().requireOwnThread(session(ALICE), { threadId: THREAD })).resolves.toBeUndefined();
    await expect(access().requireOwnThread(session(ALICE), { messageId: MESSAGE })).resolves.toBeUndefined();
  });

  it('reads as not found to anyone else, a platform admin included', async () => {
    const admin = { userId: 'u-admin', mode: 'session', isAdmin: true } as never;
    for (const who of [session('u-bob'), admin]) {
      await expect(access().requireOwnThread(who, { threadId: THREAD })).rejects.toBeInstanceOf(NotFoundException);
      await expect(access().requireOwnThread(who, { messageId: MESSAGE })).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('keeps working as the dev principal', async () => {
    await expect(access().requireOwnThread(DEV_PRINCIPAL, { threadId: THREAD })).resolves.toBeUndefined();
  });

  it('the guard holds both sources to it', async () => {
    const requireOwnThread = vi.fn(async () => undefined);
    const guardAccess = { workspaceOf: async () => WS, requireRole: async () => undefined, requireOwnThread };
    const reflectorFor = (source: string) => ({ getAllAndOverride: () => false, get: () => ({ role: 'viewer', source, operator: false }) });
    const run = (source: string, id: string) =>
      new AclGuard(reflectorFor(source) as never, guardAccess as never, {} as never).canActivate({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => ({ principal: session(ALICE), method: 'GET', params: { id }, query: {}, body: {} }) }),
      } as never);
    await run('assistant-thread', THREAD);
    await run('assistant-message', MESSAGE);
    expect(requireOwnThread.mock.calls.map((c: unknown[]) => c[1])).toEqual([{ threadId: THREAD }, { messageId: MESSAGE }]);
  });

  it('lists only the caller\'s threads', async () => {
    const findMany = vi.fn(async () => []);
    const threads = new AssistantThreadsService({ assistantThread: { findMany } } as never, {} as never, {} as never);
    await threads.listThreads(WS, ALICE);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, createdBy: ALICE }) }));
  });
});

/**
 * #813: pages the user applies from the composer are read through the same
 * check as the grounding page, so a restricted page never reaches the prompt.
 */
describe('applied documents (documentRefs)', () => {
  const SECRET = '66666666-6666-4666-8666-666666666666';
  const OPEN = '77777777-7777-4777-8777-777777777777';
  const MISSING = '88888888-8888-4888-8888-888888888888';
  const pages: Record<string, { id: string; workspaceId: string; title: string; projectId: string; path: string; restrictedBy: string[] }> = {
    [SECRET]: { id: SECRET, workspaceId: WS, title: 'Salaries', projectId: 'p-1', path: `/${SECRET}/`, restrictedBy: [SECRET] },
    [OPEN]: { id: OPEN, workspaceId: WS, title: 'Onboarding', projectId: 'p-1', path: `/${OPEN}/`, restrictedBy: [] },
  };
  const member = { workspaceId: WS, bypass: false, guest: false, denied: new Set([SECRET]), granted: new Set() } as unknown as AccessScope;

  async function turn(documentRefs: string[]) {
    const svc = Object.create(AssistantService.prototype) as AssistantService;
    const documents = {
      getContent: vi.fn(async (id: string) => ({ markdown: id === SECRET ? 'CEO earns 1M' : 'Read the handbook' })),
      breadcrumbsFor: vi.fn(async () => new Map()),
    };
    Object.assign(svc, {
      permissions: { scopeFor: vi.fn(async () => member) },
      prisma: { document: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => pages[where.id] ?? null) } },
      documents,
      code: { repositories: vi.fn(async () => []) },
      tasks: { repositories: vi.fn(async () => []) },
      tools: { chatAvailable: vi.fn(async () => false) },
      skills: { forTurn: vi.fn(async () => []), renderPrompt: () => '' },
      learnings: { promptFor: vi.fn(async () => ({ prompt: '' })) },
      threads: { recentHistory: vi.fn(async () => []) },
    });
    const thread = { id: 't-1', workspaceId: WS, documentId: null };
    const agent = { instructions: 'You help.', config: { webAccess: { effective: 'off' } }, skillIds: [], key: 'researcher' };
    const prepared = await (svc as unknown as { prepareTurn: (...a: unknown[]) => Promise<{ messages: Array<{ content: string }>; collected: Map<string, unknown> }> })
      .prepareTurn(thread, { content: 'What do we pay?', documentRefs }, 'm-1', agent, 'ask', DEV_PRINCIPAL);
    return { system: prepared.messages[0]!.content, collected: prepared.collected, documents };
  }

  it('drops a page the member cannot open, unread and untitled', async () => {
    const { system, collected, documents } = await turn([SECRET, MISSING]);
    expect(system).not.toContain('CEO earns 1M');
    expect(system).not.toContain('Salaries');
    expect(system).toContain('2 other document(s) the user applied are not available to you');
    expect(collected.has(SECRET)).toBe(false);
    expect(documents.getContent).not.toHaveBeenCalledWith(SECRET);
  });

  it('still includes a page the member can open', async () => {
    const { system, collected } = await turn([OPEN, SECRET]);
    expect(system).toContain('Read the handbook');
    expect(system).toContain('"Onboarding"');
    expect(system).toContain('1 other document(s)');
    expect(collected.has(OPEN)).toBe(true);
  });
});
