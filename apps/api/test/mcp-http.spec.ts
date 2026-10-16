import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpController } from '../src/mcp/mcp.controller.js';
import { AccessService } from '../src/auth/access.service.js';
import { AclGuard } from '../src/auth/acl.guard.js';
import { READ_KEY_OK_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { CAPTURE_TOOLS, WRITE_TOOLS, settleTools } from '../src/mcp/mcp-tools.js';
import { renderSkill } from '../src/mcp/skill.js';
import { AiReadableService } from '../src/ai-readable/ai-readable.service.js';
import { AiReadableController } from '../src/ai-readable/ai-readable.controller.js';

/**
 * MCP over HTTP and named API keys (docs/features/33).
 *
 * The HTTP transport is the first time these tools run as somebody other than
 * a fully trusted local process, so what is pinned here is the boundary:
 *
 * 1. **A key only ever narrows.** The scope and workspace pin are checked
 *    before the platform-admin shortcut — otherwise an admin's read-only key
 *    writes anyway, which is the one thing a read-only key promises not to do.
 * 2. **Every tool checks before it acts.** A tool whose handler reached its
 *    service before `requireRole` would be a cross-tenant read with a 200.
 * 3. **The offer matches the check.** A read-only key is not shown the write
 *    tools, and WRITE_TOOLS cannot name a tool that does not exist — the list
 *    is both the annotation source and the filter, so drift would silently
 *    offer a write as read-only.
 */

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

function keyPrincipal(apiKey: NonNullable<Principal['apiKey']>, extra: Partial<Principal> = {}): Principal {
  return {
    userId: '33333333-3333-4333-8333-333333333333',
    email: 'agent@example.com',
    displayName: 'Agent',
    avatarUrl: null,
    mode: 'api-key',
    isAdmin: false,
    locale: 'en',
    apiKey,
    ...extra,
  };
}

function accessWith(role: 'guest' | 'viewer' | 'editor' | 'admin' | null) {
  const prisma = {
    workspaceMember: {
      findUnique: vi.fn(async () => (role ? { role, trustedOperator: false } : null)),
    },
    workspace: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    connector: { findUnique: vi.fn(async () => ({ workspaceId: WS_A })) },
  };
  return new AccessService(prisma as never);
}

describe('AccessService key narrowing', () => {
  it('refuses a read-only key an editor role even when the owner is an editor', async () => {
    const access = accessWith('editor');
    const p = keyPrincipal({ id: 'k', scope: 'read', workspaceId: null });
    await expect(access.requireRole(p, WS_A, 'viewer')).resolves.toBeUndefined();
    await expect(access.requireRole(p, WS_A, 'editor')).rejects.toThrow(/apiKeyReadOnly/);
  });

  it('applies the narrowing before the platform-admin shortcut', async () => {
    const access = accessWith(null);
    const admin = keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }, { isAdmin: true });
    await expect(access.requireRole(admin, WS_A, 'admin')).rejects.toThrow(/apiKeyReadOnly/);
  });

  it('refuses a pinned key every other workspace', async () => {
    const access = accessWith('admin');
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A });
    await expect(access.requireRole(p, WS_A, 'admin')).resolves.toBeUndefined();
    await expect(access.requireRole(p, WS_B, 'viewer')).rejects.toThrow(/apiKeyWorkspace/);
  });

  it('never widens: a write key is still bounded by the owner role', async () => {
    const access = accessWith('viewer');
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: null });
    await expect(access.requireRole(p, WS_A, 'editor')).rejects.toThrow(/roleRequired/);
  });

  describe('capture scope (issue #73)', () => {
    const capture = () => keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null });

    it('reads like a read key, and reaches editor only on a capture call', async () => {
      const access = accessWith('admin');
      await expect(access.requireRole(capture(), WS_A, 'viewer')).resolves.toBeUndefined();
      await expect(access.requireRole(capture(), WS_A, 'editor')).rejects.toThrow(/apiKeyCaptureOnly/);
      await expect(access.requireRole(capture(), WS_A, 'editor', false, { capture: true })).resolves.toBeUndefined();
    });

    it('is never lifted past editor, whatever the owner holds', async () => {
      const access = accessWith('admin');
      await expect(access.requireRole(capture(), WS_A, 'admin', false, { capture: true })).rejects.toThrow(/apiKeyCaptureOnly/);
      const admin = keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null }, { isAdmin: true });
      await expect(access.requireRole(admin, WS_A, 'admin', false, { capture: true })).rejects.toThrow(/apiKeyCaptureOnly/);
    });

    it('does not widen: the flag is no help to a read key, and the owner role still bounds it', async () => {
      const read = keyPrincipal({ id: 'k', scope: 'read', workspaceId: null });
      await expect(accessWith('editor').requireRole(read, WS_A, 'editor', false, { capture: true })).rejects.toThrow(/apiKeyReadOnly/);
      await expect(accessWith('viewer').requireRole(capture(), WS_A, 'editor', false, { capture: true })).rejects.toThrow(/roleRequired/);
    });

    it('keeps its workspace pin', async () => {
      const pinned = keyPrincipal({ id: 'k', scope: 'capture', workspaceId: WS_A });
      await expect(accessWith('editor').requireRole(pinned, WS_B, 'editor', false, { capture: true })).rejects.toThrow(/apiKeyWorkspace/);
    });

    /** The REST guard over one route: `spec` is its @Access, `readKeyOk` its @ReadKeyOk. */
    const guardOver = (spec: AccessSpec | undefined, method: string, readKeyOk = false) => {
      const reflector = {
        getAllAndOverride: (meta: string) => (meta === READ_KEY_OK_META ? readKeyOk : false),
        get: () => spec,
      };
      const guard = new AclGuard(reflector as never, accessWith('editor'), {} as never);
      const request = { principal: capture(), method, params: {}, query: {}, body: { workspaceId: WS_A } };
      return guard.canActivate({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => request }),
      } as never);
    };

    it('is refused a non-GET route with no @Access, unless the route admits read keys', async () => {
      await expect(guardOver(undefined, 'POST')).rejects.toThrow(/apiKeyCaptureOnly/);
      await expect(guardOver(undefined, 'GET')).resolves.toBe(true);
      await expect(guardOver(undefined, 'POST', true)).resolves.toBe(true);
    });

    it('passes an editor route only when the route says capture', async () => {
      const editor: AccessSpec = { role: 'editor', source: 'body', operator: false };
      await expect(guardOver(editor, 'POST')).rejects.toThrow(/apiKeyCaptureOnly/);
      await expect(guardOver({ ...editor, capture: true }, 'POST')).resolves.toBe(true);
      await expect(guardOver({ ...editor, role: 'admin', capture: true }, 'POST')).rejects.toThrow(/apiKeyCaptureOnly/);
    });
  });
});

/** An McpService whose collaborators are spies; only what a test touches is real. */
function service(access: AccessService, aiReadable: unknown = { enabled: () => true }) {
  const search = { search: vi.fn(async () => ({ results: [] })) };
  const documents = {
    createDocument: vi.fn(async () => ({ documentId: 'd' })),
    getTree: vi.fn(async () => ({ nodes: [] })),
  };
  const config = { get: (key: string) => ({ AUTH_MODE: 'api-key', API_PUBLIC_URL: 'https://kb.example.com/api' })[key] };
  const deps = {
    prisma: {},
    storage: {},
    documents,
    compare: {},
    search,
    mergeRequests: {},
    mergeRequestThreads: {},
    entities: {},
    graph: {},
    audit: {},
    // Page permissions (#76) are pinned in test/permissions.spec.ts; here the
    // page check is the workspace check and every page is visible.
    permissions: {
      requireResource: vi.fn(async (p: Principal, ws: string, _r: unknown, role: 'viewer' | 'editor' | 'admin') =>
        access.requireRole(p, ws, role),
      ),
      scopeFor: vi.fn(async (_p: Principal, workspaceId: string) => ({
        workspaceId,
        bypass: true,
        guest: false,
        denied: new Set(),
        granted: new Set(),
      })),
      requireCreateUnder: vi.fn(async () => undefined),
    },
    history: {},
    ingestionAdmin: {},
    workflows: {},
    projects: {},
    connectors: {},
    workItems: {},
    connectorProducer: { enqueue: vi.fn(async () => undefined) },
    agents: {},
    access,
    config,
    aiReadable,
    provenance: { decorateResults: vi.fn(async (_ws: string, results: unknown[]) => results) },
    feedback: {
      voteOverMcp: vi.fn(async () => ({
        feedback: { id: 'f-1', surface: 'mcp' },
        deduplicated: false,
      })),
    },
    issues: {},
    verification: {
      flag: vi.fn(async (documentId: string, state: string) => ({
        document: { documentId, verification: state, ownerId: 'owner-1' },
      })),
    },
    templates: {
      list: vi.fn(async () => ({ templates: [{ ref: 'builtin:adr' }] })),
      getByRef: vi.fn(async (_ws: string, ref: string) => ({ ref, meta: { placeholders: [] } })),
    },
    shareLinks: {
      create: vi.fn(async (documentId: string, input: { includeSubtree: boolean }) => ({
        share: { id: 'sh-1', documentId, includeSubtree: input.includeSubtree, expiresAt: null, hasPassword: true },
        url: 'https://kb.example.com/s/kp_x',
        requestedExpiresAt: null,
      })),
    },
    exports: {
      createForDocument: vi.fn(async () => ({ id: 'ex-1', status: 'queued', format: 'zip', scope: 'subtree' })),
      createForProject: vi.fn(async () => ({ id: 'ex-2', status: 'queued', format: 'zip', scope: 'project' })),
      get: vi.fn(async () => ({ id: 'ex-1', workspaceId: WS_A, status: 'completed', format: 'zip' })),
      download: vi.fn(async () => ({ url: 'https://minio/signed', filename: 'guide.zip' })),
    },
    repoWiki: {
      info: vi.fn(async (connectorId: string) => ({ connectorId, enabled: true, sections: [] })),
      regenerate: vi.fn(async () => ({
        id: 'run-1',
        connectorId: 'c-1',
        workspaceId: WS_A,
        status: 'queued',
        direction: 'pull',
        trigger: 'manual',
        mode: 'auto',
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        conflicts: 0,
        discovered: 0,
        applied: 0,
        reverted: 0,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      })),
    },
    resourceAccess: {
      get: vi.fn(async (_p: Principal, r: { type: string; id: string }) => ({
        resourceType: r.type,
        resourceId: r.id,
        restricted: true,
        inherited: [],
        level: 'view',
        canManage: false,
        grants: [],
      })),
    },
    accessRequests: {
      create: vi.fn(async (_p: Principal, dto: { resourceId: string; level: string }) => ({
        requestId: 'req-1',
        resourceId: dto.resourceId,
        level: dto.level,
        status: 'pending',
      })),
    },
    learnings: {
      list: vi.fn(async (_ws: string, filter: { status?: string }) => [{ id: 'l-1', text: 'Cite the MR id', status: filter.status }]),
      create: vi.fn(async (input: { text: string; status: string }) => ({ id: 'l-2', text: input.text, status: input.status })),
    },
    captures: {
      capture: vi.fn(async (req: { kind: string }) => ({ captureId: 'c-1', state: 'proposed', outcome: 'new-page', kind: req.kind })),
      similarPages: vi.fn(async () => [{ documentId: 'd-1', title: 'Billing', score: 0.91 }]),
      list: vi.fn(async () => ({ captures: [], nextCursor: null })),
    },
    componentUsages: {},
    componentDrafts: {
      start: vi.fn(async (_p: Principal, input: { paths: string[] }) => ({
        runId: 'run-9',
        connectorId: 'c-1',
        title: 'ResponsivePopover',
        paths: input.paths,
      })),
    },
  };
  const mcp = new McpService(...(Object.values(deps) as ConstructorParameters<typeof McpService>));
  return {
    mcp,
    search,
    documents,
    provenance: deps.provenance,
    feedback: deps.feedback,
    verification: deps.verification,
    templates: deps.templates,
    shareLinks: deps.shareLinks,
    exports: deps.exports,
    repoWiki: deps.repoWiki,
    resourceAccess: deps.resourceAccess,
    accessRequests: deps.accessRequests,
    learnings: deps.learnings,
    captures: deps.captures,
    componentDrafts: deps.componentDrafts,
  };
}

async function connect(mcp: McpService, principal: Principal) {
  const { server } = mcp.buildServer(principal);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('McpService over a principal', () => {
  it('names only tools that exist in WRITE_TOOLS and CAPTURE_TOOLS', () => {
    const { mcp } = service(accessWith('admin'));
    const names = new Set(mcp.toolsFor(DEV_PRINCIPAL).map((t) => t.name));
    for (const name of WRITE_TOOLS) expect(names, name).toContain(name);
    for (const name of CAPTURE_TOOLS) expect(names, name).toContain(name);
  });

  it('annotates reads read-only, and hides writes from a read-only key', async () => {
    const { mcp } = service(accessWith('editor'));
    const full = await connect(mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: null }));
    const { tools } = await full.listTools();
    expect(tools.find((t) => t.name === 'knowledge_search')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'knowledge_create_document')?.annotations?.readOnlyHint).toBe(false);

    const reader = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    const offered = (await reader.listTools()).tools.map((t) => t.name);
    expect(offered).toContain('knowledge_search');
    for (const name of WRITE_TOOLS) expect(offered).not.toContain(name);
    // Spelled out for #236: drafting a component queues a model run that ends in a merge request.
    expect(offered).not.toContain('knowledge_document_component');
    expect(tools.find((t) => t.name === 'knowledge_document_component')?.annotations?.readOnlyHint).toBe(false);
  });

  it('drafts a component as its caller, and refuses a viewer (#236)', async () => {
    const editor = service(accessWith('editor'));
    const principal = keyPrincipal({ id: 'k', scope: 'write', workspaceId: null });
    const writer = await connect(editor.mcp, principal);
    const paths = ['apps/web/src/components/ResponsivePopover.vue'];
    const res = await writer.callTool({ name: 'knowledge_document_component', arguments: { workspaceId: WS_A, paths } });
    expect(res.isError).toBeFalsy();
    expect(editor.componentDrafts.start).toHaveBeenCalledWith(principal, { workspaceId: WS_A, paths });

    const viewer = service(accessWith('viewer'));
    const reader = await connect(viewer.mcp, principal);
    const refused = await reader.callTool({ name: 'knowledge_document_component', arguments: { workspaceId: WS_A, paths } });
    expect(refused.isError).toBe(true);
    expect(viewer.componentDrafts.start).not.toHaveBeenCalled();
  });

  it('offers a capture key the reads and nothing that writes, merges, approves or syncs (#73)', async () => {
    const { mcp } = service(accessWith('editor'));
    const agent = await connect(mcp, keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null }));
    const offered = (await agent.listTools()).tools.map((t) => t.name);
    expect(offered).toContain('knowledge_search');
    for (const name of WRITE_TOOLS) if (!CAPTURE_TOOLS.has(name)) expect(offered).not.toContain(name);
    for (const name of [
      'knowledge_create_revision',
      'knowledge_merge_revision',
      'knowledge_approve_merge_request',
      'knowledge_sync_connector',
      'knowledge_ingest',
      'knowledge_start_workflow',
      'knowledge_create_document',
    ]) {
      expect(offered).not.toContain(name);
    }
    const reader = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    const read = (await reader.listTools()).tools.map((t) => t.name);
    for (const name of CAPTURE_TOOLS) expect(read).not.toContain(name);
    // The reads (find_similar and list_captures among them) plus the five capture tools, nothing else.
    expect([...offered].sort()).toEqual([...read, ...CAPTURE_TOOLS].sort());
    expect(read).toEqual(expect.arrayContaining(['knowledge_find_similar', 'knowledge_list_captures']));
  });

  it('runs a capture tool as its caller through the capture guard (#73)', async () => {
    const { mcp, captures } = service(accessWith('editor'));
    const principal = keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null });
    const agent = await connect(mcp, principal);
    const res = await agent.callTool({
      name: 'knowledge_capture_decision',
      arguments: {
        workspaceId: WS_A,
        projectId: WS_A,
        title: 'Fuse vector and BM25 with RRF',
        context: 'Two rankings, incomparable scores.',
        decision: 'Reciprocal rank fusion, k=60.',
        session: { client: 'claude-code', repo: 'acme/kb', commit: 'abc123' },
      },
    });
    expect(res.isError).toBeFalsy();
    expect(captures.capture).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'decision', workspaceId: WS_A, session: expect.objectContaining({ client: 'claude-code' }) }),
      principal,
    );
  });

  it('refuses a capture tool to a capture key whose person is only a viewer (#73)', async () => {
    const { mcp, captures } = service(accessWith('viewer'));
    const agent = await connect(mcp, keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null }));
    const res = await agent.callTool({
      name: 'knowledge_capture_note',
      arguments: {
        workspaceId: WS_A,
        projectId: WS_A,
        kind: 'gotcha',
        title: 'x',
        body: 'y',
        session: { client: 'cursor' },
      },
    });
    expect(res.isError).toBe(true);
    expect(captures.capture).not.toHaveBeenCalled();
  });

  it('settles a capture tool as offered to a capture or write key and hidden from a read key (#73)', () => {
    const [captureTool] = CAPTURE_TOOLS;
    const handles = () => {
      const handle = (name: string) => ({ description: name, annotations: {}, remove: vi.fn(), update: vi.fn() });
      return new Map([
        ['knowledge_search', handle('knowledge_search')],
        ['knowledge_merge_revision', handle('knowledge_merge_revision')],
        [captureTool, handle(captureTool)],
      ]) as unknown as Parameters<typeof settleTools>[0];
    };
    const writes = new Set([...WRITE_TOOLS, ...CAPTURE_TOOLS]);
    const offer = (scope: 'read' | 'capture' | 'write') =>
      settleTools(handles(), keyPrincipal({ id: 'k', scope, workspaceId: null }))
        .map((t) => t.name)
        .filter((name) => name === 'knowledge_search' || writes.has(name));
    const captureOffer = offer('capture');
    expect(captureOffer).toContain('knowledge_search');
    expect(captureOffer).not.toContain('knowledge_merge_revision');
    expect(offer('read')).toEqual(['knowledge_search']);
    expect(offer('write')).toEqual(expect.arrayContaining(['knowledge_search', 'knowledge_merge_revision', captureTool]));
    const annotated = settleTools(handles(), keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null }));
    expect(annotated.find((t) => t.name === captureTool)?.readOnly).toBe(false);
  });

  it('keeps CAPTURE_TOOLS out of WRITE_TOOLS — a tool is a write when it is in either', () => {
    for (const name of CAPTURE_TOOLS) expect(WRITE_TOOLS.has(name), name).toBe(false);
  });

  it('offers the template reads to a read-only key and fills a page in from a template (issue #69)', async () => {
    const { mcp, templates, documents } = service(accessWith('editor'));
    const reader = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    const offered = (await reader.listTools()).tools.map((t) => t.name);
    expect(offered).toEqual(expect.arrayContaining(['knowledge_list_templates', 'knowledge_get_template']));
    expect(offered).not.toContain('knowledge_create_document');
    const got = await reader.callTool({ name: 'knowledge_get_template', arguments: { workspaceId: WS_A, templateRef: 'builtin:adr' } });
    expect(got.isError).toBeFalsy();
    expect(templates.getByRef).toHaveBeenCalledWith(WS_A, 'builtin:adr', undefined);

    const writer = await connect(mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: null }));
    const project = '55555555-5555-4555-8555-555555555555';
    const neither = await writer.callTool({
      name: 'knowledge_create_document',
      arguments: { workspaceId: WS_A, projectId: project, title: 'x' },
    });
    expect(neither.isError).toBe(true);
    expect(documents.createDocument).not.toHaveBeenCalled();

    const created = await writer.callTool({
      name: 'knowledge_create_document',
      arguments: { workspaceId: WS_A, projectId: project, title: 'Use Postgres', templateRef: 'builtin:adr', values: { number: '1' } },
    });
    expect(created.isError).toBeFalsy();
    expect(documents.createDocument).toHaveBeenCalledWith(
      { workspaceId: WS_A, projectId: project, title: 'Use Postgres', template: { ref: 'builtin:adr', version: undefined, values: { number: '1' } } },
      expect.any(String),
    );
  });

  it('checks the workspace before the service runs', async () => {
    const { mcp, search } = service(accessWith('viewer'));
    const client = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: WS_A }));
    const denied = await client.callTool({ name: 'knowledge_search', arguments: { workspaceId: WS_B, query: 'x' } });
    expect(denied.isError).toBe(true);
    expect(search.search).not.toHaveBeenCalled();

    const allowed = await client.callTool({ name: 'knowledge_search', arguments: { workspaceId: WS_A, query: 'x' } });
    expect(allowed.isError).toBeFalsy();
    expect(search.search).toHaveBeenCalledOnce();
  });

  it('lets a guest search and browse the tree, scoped, but not reach workspace tools (#76)', async () => {
    const { mcp, search, documents } = service(accessWith('guest'));
    const client = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    const found = await client.callTool({ name: 'knowledge_search', arguments: { workspaceId: WS_A, query: 'x' } });
    expect(found.isError).toBeFalsy();
    expect(search.search).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: WS_A }));
    const tree = await client.callTool({ name: 'knowledge_list_documents', arguments: { workspaceId: WS_A } });
    expect(tree.isError).toBeFalsy();
    expect(documents.getTree).toHaveBeenCalledOnce();

    const refused = await client.callTool({ name: 'knowledge_list_templates', arguments: { workspaceId: WS_A } });
    expect(refused.isError).toBe(true);
  });

  it('knowledge_get_page_access is a read that checks the page before describing it (#76)', async () => {
    const doc = '44444444-4444-4444-8444-444444444444';
    const svc = service(accessWith('viewer'));
    (svc.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_B);
    const p = keyPrincipal({ id: 'k', scope: 'read', workspaceId: WS_A });
    const client = await connect(svc.mcp, p);
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'knowledge_get_page_access')?.annotations?.readOnlyHint).toBe(true);

    const refused = await client.callTool({ name: 'knowledge_get_page_access', arguments: { documentId: doc } });
    expect(refused.isError).toBe(true);
    expect(svc.resourceAccess.get).not.toHaveBeenCalled();

    (svc.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);
    const res = await client.callTool({ name: 'knowledge_get_page_access', arguments: { documentId: doc } });
    expect(res.isError).toBeFalsy();
    expect(svc.resourceAccess.get).toHaveBeenCalledWith(p, { type: 'document', id: doc });
  });

  it('knowledge_request_access is a write: hidden from a read-only key, filed in the caller’s name (#76)', async () => {
    const doc = '44444444-4444-4444-8444-444444444444';
    const reader = service(accessWith('viewer'));
    const readClient = await connect(reader.mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    expect((await readClient.listTools()).tools.map((t) => t.name)).not.toContain('knowledge_request_access');

    // A guest passes the workspace gate; whether they may ask about this page
    // is the service's decision, as on REST.
    const svc = service(accessWith('guest'));
    (svc.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A });
    const client = await connect(svc.mcp, p);
    expect((await client.listTools()).tools.find((t) => t.name === 'knowledge_request_access')?.annotations?.readOnlyHint).toBe(false);
    const res = await client.callTool({
      name: 'knowledge_request_access',
      arguments: { documentId: doc, level: 'edit', message: 'on call this week' },
    });
    expect(res.isError).toBeFalsy();
    expect(svc.accessRequests.create).toHaveBeenCalledWith(p, {
      workspaceId: WS_A,
      resourceType: 'document',
      resourceId: doc,
      level: 'edit',
      message: 'on call this week',
    });

    const outsider = service(accessWith(null));
    (outsider.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);
    const outsiderClient = await connect(outsider.mcp, p);
    const refused = await outsiderClient.callTool({ name: 'knowledge_request_access', arguments: { documentId: doc, level: 'view' } });
    expect(refused.isError).toBe(true);
    expect(outsider.accessRequests.create).not.toHaveBeenCalled();
  });

  it('learnings: a read-only key lists them; proposing is an editor write that can only propose (#70)', async () => {
    const reader = service(accessWith('viewer'));
    const readClient = await connect(reader.mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: WS_A }));
    const names = (await readClient.listTools()).tools.map((t) => t.name);
    expect(names).toContain('knowledge_list_agent_learnings');
    expect(names).not.toContain('knowledge_propose_agent_learning');
    const listed = await readClient.callTool({ name: 'knowledge_list_agent_learnings', arguments: { workspaceId: WS_A } });
    expect(listed.isError).toBeFalsy();
    // Active by default: what an outside agent should follow is what an admin approved.
    expect(reader.learnings.list).toHaveBeenCalledWith(WS_A, { status: 'active' });

    // A viewer holding a write key is still a viewer.
    const viewerClient = await connect(reader.mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A }));
    const refused = await viewerClient.callTool({
      name: 'knowledge_propose_agent_learning',
      arguments: { workspaceId: WS_A, text: 'Cite the MR id' },
    });
    expect(refused.isError).toBe(true);
    expect(reader.learnings.create).not.toHaveBeenCalled();

    const editor = service(accessWith('editor'));
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A });
    const client = await connect(editor.mcp, p);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'knowledge_propose_agent_learning');
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    const res = await client.callTool({
      name: 'knowledge_propose_agent_learning',
      arguments: { workspaceId: WS_A, text: 'Cite the MR id', agentKey: 'reviewer' },
    });
    expect(res.isError).toBeFalsy();
    expect(editor.learnings.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A, agentKey: 'reviewer', status: 'proposed', sourceKind: 'manual' }),
      p.userId,
    );
  });

  it('decorates search hits with provenance in one batch and names the trace (docs/features/38)', async () => {
    const { mcp, search, provenance } = service(accessWith('viewer'));
    search.search.mockResolvedValueOnce({
      results: [{ documentId: 'd1', revisionId: 'r1', chunkId: 'c1', title: 'T', snippet: '', score: 0.7 }],
    } as never);
    provenance.decorateResults.mockImplementationOnce(async (_ws: string, results: unknown[]) =>
      (results as Array<Record<string, unknown>>).map((r) => ({ ...r, revisionNumber: 3, verification: 'verified' })),
    );
    const client = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: WS_A }));
    const res = await client.callTool({ name: 'knowledge_search', arguments: { workspaceId: WS_A, query: 'x' } });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
      results: Array<Record<string, unknown>>;
      traceId: string;
    };
    expect(provenance.decorateResults).toHaveBeenCalledWith(WS_A, expect.any(Array));
    expect(body.results[0]).toMatchObject({ documentId: 'd1', revisionNumber: 3, verification: 'verified' });
    expect(body.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('knowledge_flag_document needs viewer for requested and editor for outdated, and records the mcp source (docs/features/39)', async () => {
    const { mcp, verification } = service(accessWith('viewer'));
    const client = await connect(mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A }));
    const doc = '44444444-4444-4444-8444-444444444444';
    // The guard resolves the document's workspace before the role check.
    (mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);

    const asked = await client.callTool({
      name: 'knowledge_flag_document',
      arguments: { workspaceId: WS_A, documentId: doc, state: 'requested', note: 'please re-check the SLA table' },
    });
    expect(asked.isError).toBeFalsy();
    expect(verification.flag).toHaveBeenCalledWith(
      doc,
      'requested',
      expect.objectContaining({ note: 'please re-check the SLA table', source: expect.objectContaining({ kind: 'mcp' }) }),
    );

    // A viewer may ask, but may not declare a page wrong.
    const refused = await client.callTool({
      name: 'knowledge_flag_document',
      arguments: { workspaceId: WS_A, documentId: doc, state: 'outdated' },
    });
    expect(refused.isError).toBe(true);
    expect(verification.flag).toHaveBeenCalledTimes(1);
  });

  it('knowledge_share_page needs editor, is hidden from a read-only key, and returns the link (docs/features/43)', async () => {
    const doc = '44444444-4444-4444-8444-444444444444';
    const reader = service(accessWith('editor'));
    const readClient = await connect(reader.mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    expect((await readClient.listTools()).tools.map((t) => t.name)).not.toContain('knowledge_share_page');

    const viewer = service(accessWith('viewer'));
    (viewer.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);
    const viewerClient = await connect(viewer.mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A }));
    const refused = await viewerClient.callTool({ name: 'knowledge_share_page', arguments: { workspaceId: WS_A, documentId: doc } });
    expect(refused.isError).toBe(true);
    expect(viewer.shareLinks.create).not.toHaveBeenCalled();

    const editor = service(accessWith('editor'));
    (editor.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A });
    const client = await connect(editor.mcp, p);
    const res = await client.callTool({
      name: 'knowledge_share_page',
      arguments: { workspaceId: WS_A, documentId: doc, includeSubtree: true, password: 'hunter22' },
    });
    expect(res.isError).toBeFalsy();
    expect(editor.shareLinks.create).toHaveBeenCalledWith(
      doc,
      { includeSubtree: true, expiresAt: null, password: 'hunter22' },
      p.userId,
    );
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as { url: string };
    expect(body.url).toBe('https://kb.example.com/s/kp_x');
  });

  it('knowledge_export and knowledge_get_export work with a read-only key, as a viewer (docs/features/45)', async () => {
    const doc = '44444444-4444-4444-8444-444444444444';
    const viewer = service(accessWith('viewer'));
    (viewer.mcp as unknown as { access: AccessService }).access.workspaceOfDocument = vi.fn(async () => WS_A);
    (viewer.mcp as unknown as { access: AccessService }).access.workspaceOfExport = vi.fn(async () => WS_A);
    const p = keyPrincipal({ id: 'k', scope: 'read', workspaceId: WS_A });
    const client = await connect(viewer.mcp, p);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['knowledge_export', 'knowledge_get_export']));

    const asked = await client.callTool({
      name: 'knowledge_export',
      arguments: { workspaceId: WS_A, format: 'zip', documentId: doc, includeSubtree: true },
    });
    expect(asked.isError).toBeFalsy();
    expect(viewer.exports.createForDocument).toHaveBeenCalledWith(doc, { format: 'zip', includeSubtree: true, branch: undefined }, p);

    const both = await client.callTool({
      name: 'knowledge_export',
      arguments: { workspaceId: WS_A, format: 'zip', documentId: doc, projectId: doc },
    });
    expect(both.isError).toBe(true);

    const got = await client.callTool({ name: 'knowledge_get_export', arguments: { workspaceId: WS_A, exportId: doc } });
    const body = JSON.parse((got.content as Array<{ text: string }>)[0]!.text) as { download: { url: string } };
    expect(body.download.url).toBe('https://minio/signed');
  });

  it('knowledge_feedback stores a vote as the caller with surface mcp, and insists on a reason for a down-vote', async () => {
    const { mcp, feedback } = service(accessWith('viewer'));
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: WS_A });
    const client = await connect(mcp, p);

    const bare = await client.callTool({
      name: 'knowledge_feedback',
      arguments: { workspaceId: WS_A, rating: 'down', query: 'billing' },
    });
    expect(bare.isError).toBe(true);
    expect(feedback.voteOverMcp).not.toHaveBeenCalled();

    const res = await client.callTool({
      name: 'knowledge_feedback',
      arguments: { workspaceId: WS_A, rating: 'down', reason: 'outdated', query: 'billing', traceId: 't-1' },
    });
    expect(res.isError).toBeFalsy();
    expect(feedback.voteOverMcp).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_A, rating: 'down', reason: 'outdated', query: 'billing', traceId: 't-1' }),
      p,
    );
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
    expect(body).toEqual({ feedbackId: 'f-1', surface: 'mcp', deduplicated: false });

    // A workspace the key is not pinned to is refused before the service runs.
    const denied = await client.callTool({
      name: 'knowledge_feedback',
      arguments: { workspaceId: WS_B, rating: 'up', query: 'x' },
    });
    expect(denied.isError).toBe(true);
    expect(feedback.voteOverMcp).toHaveBeenCalledTimes(1);
  });

  it('attributes a write to the caller, not the stub', async () => {
    const { mcp, documents } = service(accessWith('editor'));
    const p = keyPrincipal({ id: 'k', scope: 'write', workspaceId: null });
    const client = await connect(mcp, p);
    await client.callTool({
      name: 'knowledge_create_document',
      arguments: { workspaceId: WS_A, projectId: WS_B, title: 'T', content: '# T' },
    });
    expect(documents.createDocument).toHaveBeenCalledWith(expect.objectContaining({ title: 'T' }), p.userId);
  });

  it('points configs at API_PUBLIC_URL', () => {
    expect(service(accessWith(null)).mcp.publicUrl()).toBe('https://kb.example.com/api/v1/mcp');
  });
});

/**
 * AI-readable resources (issue #68, phase 5). One fake PG backs both the
 * AccessService (guard) and a real AiReadableService, so the MCP read and the
 * REST route run the same code over the same rows.
 */
const DOC_A = '44444444-4444-4444-8444-444444444444';
const DOC_B = '55555555-5555-4555-8555-555555555555';
const PROJ_A = '66666666-6666-4666-8666-666666666666';
const PROJ_B = '77777777-7777-4777-8777-777777777777';

function readableWorld(opts: { enabled?: boolean } = {}) {
  const docs = [
    { id: DOC_A, workspaceId: WS_A, projectId: PROJ_A, title: 'Billing', rev: 'rA' },
    { id: DOC_B, workspaceId: WS_B, projectId: PROJ_B, title: 'Secret', rev: 'rB' },
  ];
  const projects = [
    { id: PROJ_A, workspaceId: WS_A, name: 'Platform' },
    { id: PROJ_B, workspaceId: WS_B, name: 'Other' },
  ];
  const docRow = (d: (typeof docs)[number]) => ({
    ...d,
    category: null,
    parentId: null,
    position: 0,
    defaultBranch: 'main',
    branches: [{ name: 'main', headRevisionId: d.rev }],
    project: { name: projects.find((p) => p.id === d.projectId)!.name },
  });
  const revRow = (id: string) => {
    const d = docs.find((x) => x.rev === id);
    return d
      ? { id, documentId: d.id, status: 'indexed', revisionNumber: 2, s3Key: `k/${id}`, finalizedAt: new Date(0), createdAt: new Date(0) }
      : null;
  };
  const matches = (d: (typeof docs)[number], w: Record<string, string>) =>
    (!w.workspaceId || d.workspaceId === w.workspaceId) && (!w.projectId || d.projectId === w.projectId) && (!w.id || d.id === w.id);
  const prisma = {
    workspaceMember: { findUnique: vi.fn(async () => ({ role: 'viewer', trustedOperator: false })) },
    workspace: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: `WS ${where.id.slice(0, 2)}` })) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => projects.find((p) => p.id === where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string } }) => projects.filter((p) => p.workspaceId === where.workspaceId)),
    },
    document: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => docs.find((d) => d.id === where.id) ?? null),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const d = docs.find((x) => x.id === where.id);
        return d ? docRow(d) : null;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, string> }) => docs.filter((d) => matches(d, where)).length),
      findMany: vi.fn(async ({ where }: { where: Record<string, string> }) => docs.filter((d) => matches(d, where)).map(docRow)),
    },
    documentRevision: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => revRow(where.id)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(revRow).filter(Boolean)),
    },
  };
  const documents = {
    getContent: vi.fn(async (id: string) => ({ markdown: `Body of ${id}.\n`, frontmatter: { tags: ['t'] } })),
  };
  const env: Record<string, unknown> = {
    AI_READABLE_ENABLED: opts.enabled ?? true,
    WEB_BASE_URL: 'https://kb.example.com',
    API_PUBLIC_URL: 'https://kb.example.com/api',
  };
  const config = { get: (key: string) => env[key] };
  const aiReadable = new AiReadableService(prisma as never, documents as never, config as never);
  const access = new AccessService(prisma as never);
  return { aiReadable, access, documents, prisma };
}

describe('MCP AI-readable resources', () => {
  const pinnedToA = () => keyPrincipal({ id: 'k', scope: 'read', workspaceId: WS_A });

  it('offers the three templates, and no llms-full', async () => {
    const world = readableWorld();
    const client = await connect(service(world.access, world.aiReadable).mcp, pinnedToA());
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate);
    expect(uris).toEqual(
      expect.arrayContaining([
        'knowledge://documents/{documentId}.md',
        'knowledge://workspaces/{workspaceId}/llms.txt',
        'knowledge://projects/{projectId}/llms.txt',
      ]),
    );
    expect(uris.some((u) => u.includes('llms-full'))).toBe(false);
    expect(resourceTemplates.find((t) => t.uriTemplate.endsWith('.md'))?.mimeType).toBe('text/markdown');
  });

  it('reads a page byte-identical to GET /v1/documents/:id/markdown', async () => {
    const world = readableWorld();
    const client = await connect(service(world.access, world.aiReadable).mcp, pinnedToA());
    const read = await client.readResource({ uri: `knowledge://documents/${DOC_A}.md` });
    const content = read.contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe('text/markdown');

    const res = { setHeader: vi.fn(), status: vi.fn() };
    const rest = await new AiReadableController(world.aiReadable).markdown(
      DOC_A,
      { headers: {} } as never,
      res as never,
    );
    expect(rest).toBeTruthy();
    expect(content.text).toBe(rest);
    expect(content.text).toContain(`Body of ${DOC_A}.`);
  });

  it('reads workspace and project llms.txt through the same service', async () => {
    const world = readableWorld();
    const client = await connect(service(world.access, world.aiReadable).mcp, pinnedToA());
    const ws = await client.readResource({ uri: `knowledge://workspaces/${WS_A}/llms.txt` });
    const expected = await world.aiReadable.workspaceIndex(WS_A);
    expect(expected.status).toBe(200);
    expect((ws.contents[0] as { text: string }).text).toBe(expected.status === 200 ? expected.body : '');
    expect((ws.contents[0] as { text: string }).text).toContain(`https://kb.example.com/documents/${DOC_A}.md`);

    const proj = await client.readResource({ uri: `knowledge://projects/${PROJ_A}/llms.txt` });
    const expectedProj = await world.aiReadable.projectIndex(PROJ_A);
    expect((proj.contents[0] as { text: string }).text).toBe(expectedProj.status === 200 ? expectedProj.body : '');
  });

  it('refuses a key pinned to workspace A every workspace-B resource, before any content is read', async () => {
    const world = readableWorld();
    const client = await connect(service(world.access, world.aiReadable).mcp, pinnedToA());
    for (const uri of [
      `knowledge://documents/${DOC_B}.md`,
      `knowledge://workspaces/${WS_B}/llms.txt`,
      `knowledge://projects/${PROJ_B}/llms.txt`,
    ]) {
      await expect(client.readResource({ uri }), uri).rejects.toThrow(/apiKeyWorkspace/);
    }
    expect(world.documents.getContent).not.toHaveBeenCalled();
    expect(world.prisma.documentRevision.findMany).not.toHaveBeenCalled();
  });

  it('is not offered when AI_READABLE_ENABLED=false', async () => {
    const world = readableWorld({ enabled: false });
    const client = await connect(service(world.access, world.aiReadable).mcp, pinnedToA());
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toEqual([]);
    await expect(client.readResource({ uri: `knowledge://documents/${DOC_A}.md` })).rejects.toThrow();
  });
});

describe('McpController over real HTTP', () => {
  it('serves the SDK HTTP client statelessly: initialize, list, call', async () => {
    const { mcp, search } = service(accessWith('viewer'));
    const config = { get: () => 'api-key' };
    const controller = new McpController(mcp, config as never);
    const principal = keyPrincipal({ id: 'k', scope: 'read', workspaceId: null });

    // What express's json parser and AuthGuard would have done before the handler.
    const http = createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        (req as unknown as { body: unknown }).body = JSON.parse(raw);
        void controller.handle(principal, req as never, res as never);
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/mcp`);

    try {
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer kn_x' } } }));
      expect(client.getInstructions()).toContain('knowledge_whoami');
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'knowledge_whoami')).toBe(true);
      await client.callTool({ name: 'knowledge_search', arguments: { workspaceId: WS_A, query: 'billing' } });
      expect(search.search).toHaveBeenCalledOnce();
      await client.close();

      // A bare POST with no initialize first — the curl line the connection
      // page hands out. Stateless mode must answer it.
      const raw = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      });
      expect(raw.status).toBe(200);
      const body = (await raw.json()) as { id: number; result: { tools: unknown[] } };
      expect(body.id).toBe(7);
      expect(body.result.tools.length).toBeGreaterThan(10);
    } finally {
      http.close();
    }
  });
});

describe('renderSkill', () => {
  const base = {
    url: 'https://kb.example.com/api/v1/mcp',
    serverName: 'knowledge',
    version: '0.9.0',
    authMode: 'api-key' as const,
    webUrl: 'https://kb.example.com',
    whoami: {
      userId: 'u',
      email: 'a@example.com',
      displayName: 'Ada | Ops',
      mode: 'api-key' as const,
      apiKey: { scope: 'write' as const, workspaceId: null, projectIds: null },
      workspaces: [
        { workspaceId: WS_A, name: 'Eng', role: 'editor' as const, projects: [{ projectId: WS_B, name: 'Billing' }] },
      ],
    },
    tools: [
      { name: 'knowledge_search', description: 'Semantic search. More text.', readOnly: true },
      { name: 'knowledge_create_branch', description: 'Create a branch.', readOnly: false },
    ],
  };

  it('is a skill with frontmatter, the caller workspaces, and escaped cells', () => {
    const md = renderSkill(base);
    expect(md.startsWith('---\nname: knowledge-platform\ndescription: ')).toBe(true);
    expect(md).toContain(`| Eng | \`${WS_A}\` | editor | Billing (\`${WS_B}\`) |`);
    expect(md).toContain('Ada \\| Ops');
    expect(md).toContain('| `knowledge_search` | read | Semantic search. |');
    expect(md).toContain('Change an existing page');
  });

  it('lists plain-markdown URLs per workspace with a header-auth curl, never a key in a URL', () => {
    const md = renderSkill(base);
    expect(md).toContain('## Plain-markdown access');
    expect(md).toContain(`https://kb.example.com/workspaces/${WS_A}/llms.txt`);
    expect(md).toContain('https://kb.example.com/documents/<documentId>.md');
    expect(md).toContain('curl -H "Authorization: Bearer $KNOWLEDGE_API_KEY"');
    expect(md).not.toMatch(/[?&]token=/);
  });

  it('does not describe edits to a read-only key', () => {
    const md = renderSkill({
      ...base,
      whoami: { ...base.whoami, apiKey: { scope: 'read', workspaceId: WS_A, projectIds: null } },
      tools: base.tools.filter((t) => t.readOnly),
    });
    expect(md).toContain('read-only');
    expect(md).not.toContain('Change an existing page');
    expect(md).not.toContain('proposes edits');
  });

  it('names a capture key, and does not describe edits its capture tools cannot make (#73)', () => {
    const md = renderSkill({
      ...base,
      whoami: { ...base.whoami, apiKey: { scope: 'capture', workspaceId: null, projectIds: [WS_B] } },
      tools: [...base.tools.filter((t) => t.readOnly), { name: 'knowledge_capture_note', description: 'Capture.', readOnly: false }],
    });
    expect(md).toContain('capture-only');
    expect(md).toContain(`captures only into \`${WS_B}\``);
    expect(md).not.toContain('Change an existing page');
    expect(md).not.toContain('is **read-only**');
  });

  it('carries the capture playbook and the kit install line only when the capture tools are offered (#73)', () => {
    const capturing = renderSkill({
      ...base,
      tools: [...base.tools, { name: 'knowledge_capture_decision', description: 'Capture.', readOnly: false }],
    });
    expect(capturing).toContain('## Capture memory');
    expect(capturing).toContain('knowledge_find_similar');
    expect(capturing).toContain(
      'curl -fsSL -H "Authorization: Bearer $KNOWLEDGE_API_KEY" "https://kb.example.com/api/v1/mcp/capture-kit/install?client=claude-code" | sh',
    );

    const reader = renderSkill({
      ...base,
      whoami: { ...base.whoami, apiKey: { scope: 'read', workspaceId: null, projectIds: null } },
      tools: base.tools.filter((t) => t.readOnly),
    });
    expect(reader).not.toContain('Capture memory');
    expect(reader).not.toContain('capture-kit');
  });
});

describe('capture kit (#73)', () => {
  it('refuses a client it has no kit for', async () => {
    const { mcp } = service(accessWith('editor'));
    await expect(mcp.captureKitFor(keyPrincipal({ id: 'k', scope: 'write', workspaceId: null }), 'codex')).rejects.toMatchObject({
      status: 400,
      response: { reason: 'capture-kit-client' },
    });
  });

  it('refuses a read-only key, whose kit would describe calls it cannot make', async () => {
    const { mcp } = service(accessWith('editor'));
    await expect(mcp.captureKitFor(keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }), 'cursor')).rejects.toMatchObject({
      status: 403,
      response: { reason: 'capture-not-offered' },
    });
  });

  it('names only the projects a pinned capture key may capture into', async () => {
    const { mcp } = service(accessWith('editor'));
    const principal = keyPrincipal({ id: 'k', scope: 'capture', workspaceId: null, projectIds: [WS_B] });
    vi.spyOn(mcp, 'whoami').mockResolvedValue({
      userId: 'u',
      email: 'a@example.com',
      displayName: 'Ada',
      mode: 'api-key',
      apiKey: { scope: 'capture', workspaceId: null, projectIds: [WS_B] },
      workspaces: [
        {
          workspaceId: WS_A,
          name: 'Eng',
          role: 'viewer',
          projects: [
            { projectId: WS_B, name: 'Billing' },
            { projectId: WS_A, name: 'Search' },
          ],
        },
      ],
    });
    const kit = await mcp.captureKitFor(principal, 'claude-code');
    const skill = kit.files.find((f) => f.path.endsWith('SKILL.md'))!.content;
    expect(skill).toContain('Billing');
    expect(skill).not.toContain('Search —');
    const script = await mcp.captureKitInstallerFor(principal, 'claude-code');
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('https://kb.example.com/api/v1/mcp/capture-kit/install?client=claude-code');
  });
});

describe('repo wiki tools (docs/features/46)', () => {
  const CONNECTOR = '33333333-3333-4333-8333-333333333333';

  it('lets a read-only key read the wiki, and hides regenerate from it', async () => {
    const { mcp, repoWiki } = service(accessWith('viewer'));
    const reader = await connect(mcp, keyPrincipal({ id: 'k', scope: 'read', workspaceId: null }));
    const offered = (await reader.listTools()).tools.map((t) => t.name);
    expect(offered).toContain('knowledge_repo_wiki');
    expect(offered).not.toContain('knowledge_regenerate_wiki');
    const got = await reader.callTool({ name: 'knowledge_repo_wiki', arguments: { connectorId: CONNECTOR } });
    expect(got.isError).toBeFalsy();
    expect(repoWiki.info).toHaveBeenCalledWith(CONNECTOR);
  });

  it('regenerates for an editor and refuses a viewer', async () => {
    const editor = service(accessWith('editor'));
    const client = await connect(editor.mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: null }));
    const ok = await client.callTool({
      name: 'knowledge_regenerate_wiki',
      arguments: { connectorId: CONNECTOR, sections: ['architecture'], force: true },
    });
    expect(ok.isError, JSON.stringify(ok.content)).toBeFalsy();
    expect(editor.repoWiki.regenerate).toHaveBeenCalledWith(CONNECTOR, expect.objectContaining({ sections: ['architecture'], force: true }));

    const viewer = service(accessWith('viewer'));
    const refused = await (await connect(viewer.mcp, keyPrincipal({ id: 'k', scope: 'write', workspaceId: null }))).callTool({
      name: 'knowledge_regenerate_wiki',
      arguments: { connectorId: CONNECTOR },
    });
    expect(refused.isError).toBe(true);
    expect(viewer.repoWiki.regenerate).not.toHaveBeenCalled();
  });
});
