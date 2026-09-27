import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpController } from '../src/mcp/mcp.controller.js';
import { AccessService } from '../src/auth/access.service.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { WRITE_TOOLS } from '../src/mcp/mcp-tools.js';
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

function accessWith(role: 'viewer' | 'editor' | 'admin' | null) {
  const prisma = {
    workspaceMember: {
      findUnique: vi.fn(async () => (role ? { role, trustedOperator: false } : null)),
    },
    workspace: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
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
    history: {},
    ingestionAdmin: {},
    workflows: {},
    projects: {},
    connectors: {},
    workItems: {},
    connectorProducer: {},
    agents: {},
    access,
    config,
    aiReadable,
  };
  const mcp = new McpService(...(Object.values(deps) as ConstructorParameters<typeof McpService>));
  return { mcp, search, documents };
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
  it('names only tools that exist in WRITE_TOOLS', () => {
    const { mcp } = service(accessWith('admin'));
    const names = new Set(mcp.toolsFor(DEV_PRINCIPAL).map((t) => t.name));
    for (const name of WRITE_TOOLS) expect(names, name).toContain(name);
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
      apiKey: { scope: 'write' as const, workspaceId: null },
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
      whoami: { ...base.whoami, apiKey: { scope: 'read', workspaceId: WS_A } },
      tools: base.tools.filter((t) => t.readOnly),
    });
    expect(md).toContain('read-only');
    expect(md).not.toContain('Change an existing page');
    expect(md).not.toContain('proposes edits');
  });
});
