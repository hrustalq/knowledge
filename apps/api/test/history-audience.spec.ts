import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AclGuard, BRANCH_REFS, HISTORY_KEYS } from '../src/auth/acl.guard.js';
import { ACCESS_META, HISTORY_META } from '../src/auth/access.decorator.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { CAPTURE_TOOLS, WRITE_TOOLS } from '../src/mcp/mcp-tools.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

/**
 * History audience (#958): with `history_audience: editors` a caller below
 * editor reads the current page and nothing of its past, on REST and MCP.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const HEAD = '33333333-3333-4333-8333-333333333333';
const OLD = '44444444-4444-4444-8444-444444444444';

const scope = (over: Partial<AccessScope> = {}): AccessScope => ({
  workspaceId: WS,
  userId: 'u',
  role: 'viewer',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  denied: new Set(),
  granted: new Set(),
  ...over,
});

function permissions(audience: 'everyone' | 'editors') {
  const prisma = {
    document: { findUnique: vi.fn(async () => ({ defaultBranch: 'main' })) },
    // Stands for the OR in the query: the default branch's head, or a branch a merge request was opened from.
    documentBranch: {
      findMany: vi.fn(async ({ where }: { where: { headRevisionId: { in: string[] } } }) =>
        where.headRevisionId.in.filter((id) => id === HEAD).map((headRevisionId) => ({ headRevisionId })),
      ),
    },
  };
  const editing = { policy: vi.fn(async () => ({ historyAudience: { effective: audience } })) };
  const service = new PermissionService(prisma as never, {} as never, {} as never, {} as never, editing as never);
  const levelFor = vi.spyOn(service, 'levelFor');
  return { service, levelFor, prisma };
}

const refused = async (p: Promise<void>) => {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(ForbiddenException);
  // A reason a client can branch on, and never a title.
  expect((e as ForbiddenException).getResponse()).toEqual({ statusCode: 403, message: expect.any(String), reason: 'history-restricted' });
};

describe('PermissionService.requireHistory', () => {
  it('everyone: nobody is asked anything', async () => {
    const { service, levelFor } = permissions('everyone');
    await service.requireHistory(scope({ guest: true, role: 'guest' }), DOC);
    expect(levelFor).not.toHaveBeenCalled();
  });

  it('editors: a viewer of the page is refused, an editor of it reads, an admin is never asked', async () => {
    const { service, levelFor } = permissions('editors');
    levelFor.mockResolvedValueOnce('view');
    await refused(service.requireHistory(scope(), DOC));
    levelFor.mockResolvedValueOnce('edit');
    await service.requireHistory(scope({ role: 'editor' }), DOC);
    await service.requireHistory(scope({ bypass: true, role: 'admin' }), DOC);
    expect(levelFor).toHaveBeenCalledTimes(2);
  });

  it('editors, a read with no single page (as-of search or graph): the workspace role decides, a read-only key is a viewer', async () => {
    const { service } = permissions('editors');
    await refused(service.requireHistory(scope()));
    await refused(service.requireHistory(scope({ role: 'guest', guest: true })));
    await refused(service.requireHistory(scope({ role: 'editor', readOnly: true })));
    await service.requireHistory(scope({ role: 'editor' }));
  });

  it('editors: naming the current head is the current page; an older revision is history', async () => {
    const { service, levelFor } = permissions('editors');
    levelFor.mockResolvedValue('view');
    await service.requireHistory(scope(), DOC, [HEAD]);
    await refused(service.requireHistory(scope(), DOC, [OLD]));
    await refused(service.requireHistory(scope(), DOC, [HEAD, OLD]));
  });
});

describe('AclGuard asks for history by what the request reads', () => {
  function guard(meta: Record<string, unknown>) {
    const requireHistoryAs = vi.fn(async () => undefined);
    const perms = { requireResource: vi.fn(async () => undefined), requireBranches: vi.fn(async () => undefined), requireHistoryAs };
    const access = { workspaceOf: vi.fn(async () => WS), requireRole: vi.fn(async () => undefined) };
    const reflector = { get: (key: string) => meta[key], getAllAndOverride: () => undefined };
    const g = new AclGuard(reflector as never, access as never, perms as never, { require: vi.fn() } as never);
    const run = (req: Record<string, unknown>) =>
      g.canActivate({
        getHandler: () => ({}),
        getClass: () => ({}),
        switchToHttp: () => ({ getRequest: () => ({ principal: { mode: 'api-key', userId: 'u' }, method: 'GET', params: { id: DOC }, query: {}, body: {}, ...req }) }),
      } as never);
    return { run, requireHistoryAs };
  }
  const page = { [ACCESS_META]: { role: 'viewer', source: 'document' } };

  it('the current page asks nothing', async () => {
    const g = guard(page);
    await g.run({});
    expect(g.requireHistoryAs).not.toHaveBeenCalled();
  });

  it('a marked route always asks, for its page', async () => {
    const g = guard({ ...page, [HISTORY_META]: true });
    await g.run({});
    expect(g.requireHistoryAs).toHaveBeenCalledWith(expect.anything(), WS, DOC, undefined);
  });

  it('an as-of read asks whatever the route, with no exemption for a named revision', async () => {
    const g = guard(page);
    await g.run({ query: { asOf: '2026-01-01', revision: HEAD } });
    expect(g.requireHistoryAs).toHaveBeenCalledWith(expect.anything(), WS, DOC, undefined);
    const ws = guard({ [ACCESS_META]: { role: 'viewer', source: 'body' } });
    await ws.run({ method: 'POST', params: {}, body: { workspaceId: WS, knownAt: '2026-01-01' } });
    expect(ws.requireHistoryAs).toHaveBeenCalledWith(expect.anything(), WS, undefined, undefined);
  });

  it('a GET naming revisions asks about exactly those; a write naming one does not', async () => {
    const g = guard(page);
    await g.run({ query: { from: OLD, to: HEAD } });
    expect(g.requireHistoryAs).toHaveBeenCalledWith(expect.anything(), WS, DOC, [OLD, HEAD]);
    g.requireHistoryAs.mockClear();
    await g.run({ method: 'POST', body: { revisionId: OLD } });
    expect(g.requireHistoryAs).not.toHaveBeenCalled();
  });
});

/**
 * The inventory. A new route or tool that reads history fails here until it
 * is covered, so the check cannot be forgotten.
 */
describe('every history-reading surface is covered', () => {
  const src = join(import.meta.dirname, '../src');
  const files = (dir: string, end: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name), end) : e.name.endsWith(end) ? [join(dir, e.name)] : [],
    );

  it('REST: the three whole-history routes are marked', () => {
    const controller = readFileSync(join(src, 'documents/documents.controller.ts'), 'utf8');
    for (const route of [':id/revisions', ':id/branches', ':id/facts/timeline']) {
      expect(controller, route).toContain(`@Get('${route}')\n  @History()`);
    }
  });

  it('REST: every query key that names a revision or a point in time is one the guard reads', () => {
    const known = new Set<string>([...BRANCH_REFS.revisionIds.query, ...HISTORY_KEYS]);
    const named = files(src, '.controller.ts').flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/@Query\('([A-Za-z]*(?:[Rr]evision|asOf|knownAt)[A-Za-z]*)'/g)].map((m) => m[1]!),
    );
    expect(named.length).toBeGreaterThan(5);
    expect([...new Set(named)].filter((key) => !known.has(key))).toEqual([]);
  });

  // Tools that take a revision or a point in time and do not call `guard.history` themselves, each with why.
  const EXEMPT: Record<string, string> = {
    knowledge_search: 'SearchService.search asks requireHistory when asOf or knownAt is set',
  };

  it('MCP: every read tool that takes a revision or a point in time calls guard.history', () => {
    const tools = files(join(src, 'mcp/tools'), '.ts').flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('server.registerTool(')
        .slice(1)
        .map((block) => ({ name: /'(knowledge_[a-z_]+)'/.exec(block)?.[1] ?? '?', block })),
    );
    expect(tools.length).toBeGreaterThan(50);
    const reads = tools.filter((t) => !WRITE_TOOLS.has(t.name) && !CAPTURE_TOOLS.has(t.name));
    const historic = reads.filter((t) => /\b(asOf|knownAt|[A-Za-z]*[Rr]evisionId): z\./.test(t.block) || t.name === 'knowledge_list_revisions');
    expect(historic.map((t) => t.name)).toEqual(expect.arrayContaining(['knowledge_list_revisions', 'knowledge_compare_revisions', 'knowledge_get_historical_context']));
    expect(historic.filter((t) => !t.block.includes('guard.history(') && !EXEMPT[t.name]).map((t) => t.name)).toEqual([]);
    for (const name of Object.keys(EXEMPT)) expect(historic.map((t) => t.name)).toContain(name);
  });
});
