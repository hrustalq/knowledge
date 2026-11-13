import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FeaturesService } from '../src/auth/features.service.js';
import type { GraphService } from '../src/graph/graph.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #1008 acceptance, end to end against live infra: the MCP reference memory
 * server (`@modelcontextprotocol/server-memory` 2.1.1, pinned) runs over stdio
 * on a temporary file, this API serves `/mcp/<bank>/graph`, and one script of
 * calls runs against both. Every result — error flag, text blocks,
 * `structuredContent` — must be equal: the reference fixes the order of
 * everything it returns (stored order), so nothing is re-sorted first.
 *
 * Forces `AUTH_MODE=api-key` and makes its own people, none a platform admin:
 *   alice — editor of A;  carol — editor of B;  erin — editor of OFF (section off)
 *
 * Embeddings are the stub provider and no model is routed: nothing is called.
 *
 * Needs `make infra-up`. Not part of `make verify`:
 * `pnpm --filter @knowledge/api run test:e2e memory-graph-compat`.
 */

const WS_A = '10080000-0000-4008-8008-00000000000a';
const WS_B = '10080000-0000-4008-8008-00000000000b';
const WS_OFF = '10080000-0000-4008-8008-00000000000c';
const WORKSPACES = [WS_A, WS_B, WS_OFF];

type Person = { id: string; key: string };
type ToolResult = { isError: boolean; content: unknown; structuredContent: unknown };
type Step = [tool: string, args: Record<string, unknown>];

/** The script both servers run: every tool, the duplicate and missing-entity paths, cascade delete, and search over name, type and observation text. */
const SCRIPT: Step[] = [
  ['read_graph', {}],
  [
    'create_entities',
    {
      entities: [
        { name: 'Alice', entityType: 'person', observations: ['works at Acme', 'likes tea', 'likes tea'] },
        { name: 'Bob', entityType: 'person', observations: [] },
        { name: 'Acme', entityType: 'organization', observations: ['based in Berlin'] },
        { name: 'Alice', entityType: 'robot', observations: ['repeats in the batch'] },
      ],
    },
  ],
  ['create_entities', { entities: [{ name: 'Alice', entityType: 'person', observations: ['again'] }, { name: 'Carol', entityType: 'person', observations: ['plays chess'] }] }],
  ['create_entities', { entities: [{ name: 'Bob', entityType: 'person', observations: [] }, { name: 'Carol', entityType: 'person', observations: [] }] }],
  ['create_entities', { entities: [] }],
  [
    'create_relations',
    {
      relations: [
        { from: 'Alice', to: 'Acme', relationType: 'works_at' },
        { from: 'Bob', to: 'Alice', relationType: 'knows' },
        { from: 'Alice', to: 'Acme', relationType: 'works_at' },
      ],
    },
  ],
  ['create_relations', { relations: [{ from: 'Bob', to: 'Alice', relationType: 'knows' }, { from: 'Carol', to: 'Bob', relationType: 'knows' }] }],
  ['create_relations', { relations: [{ from: 'Alice', to: 'Nobody', relationType: 'knows' }] }],
  ['create_relations', { relations: [{ from: 'Nobody', to: 'Alice', relationType: 'knows' }] }],
  ['add_observations', { observations: [{ entityName: 'Alice', contents: ['likes tea', 'drinks coffee', 'drinks coffee'] }, { entityName: 'Bob', contents: ['owns a bike'] }] }],
  ['add_observations', { observations: [{ entityName: 'Bob', contents: ['never stored'] }, { entityName: 'Ghost', contents: ['x'] }] }],
  ['add_observations', { observations: [{ entityName: 'Carol', contents: ['first'] }, { entityName: 'Carol', contents: ['first', 'second'] }] }],
  ['read_graph', {}],
  ['read_graph', { entityTypes: ['organization'] }],
  ['read_graph', { observationLimit: 1 }],
  ['read_graph', { entityTypes: ['person'], observationLimit: 0 }],
  ['search_nodes', { query: 'ACME' }],
  ['search_nodes', { query: 'person', limit: 2 }],
  ['search_nodes', { query: 'Bike' }],
  ['search_nodes', { query: 'tea', observationLimit: 1 }],
  ['search_nodes', { query: 'zzz' }],
  ['open_nodes', { names: ['Bob', 'Alice', 'Nobody'] }],
  ['open_nodes', { names: ['Acme'], observationLimit: 0 }],
  ['delete_observations', { deletions: [{ entityName: 'Alice', observations: ['likes tea', 'not there'] }, { entityName: 'Ghost', observations: ['x'] }] }],
  ['delete_observations', { deletions: [{ entityName: 'Bob', observations: ['owns a bike'] }] }],
  ['delete_relations', { relations: [{ from: 'Bob', to: 'Alice', relationType: 'knows' }, { from: 'Bob', to: 'Nobody', relationType: 'knows' }] }],
  ['delete_relations', { relations: [] }],
  ['delete_entities', { entityNames: ['Acme', 'Ghost'] }],
  ['read_graph', {}],
  ['delete_entities', { entityNames: ['Carol'] }],
  ['read_graph', {}],
];

describe('MCP reference memory server compatibility (e2e, #1008)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let graph: GraphService;
  let baseUrl: string;
  const nonce = randomUUID().slice(0, 8);
  const keyIds: string[] = [];
  const people = {} as Record<'alice' | 'carol' | 'erin', Person>;
  const clients: McpClient[] = [];

  async function mintKey(userId: string, workspaceId: string, scope = 'write'): Promise<string> {
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: { userId, name: `graph e2e ${nonce}`, keyHash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 11), scope, workspaceId },
    });
    keyIds.push(row.id);
    return key;
  }

  async function person(name: string, workspaceId: string, role: 'editor' | 'viewer'): Promise<Person> {
    const email = `graph-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Graph ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId, userId: user.id } }, update: { role }, create: { workspaceId, userId: user.id, role } });
    return { id: user.id, key: await mintKey(user.id, workspaceId) };
  }

  async function connect(transport: StdioClientTransport | StreamableHTTPClientTransport): Promise<McpClient> {
    const client = new McpClient({ name: 'graph-compat', version: '0' });
    await client.connect(transport);
    clients.push(client);
    return client;
  }
  const ours = (key: string, bank: string) =>
    connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${encodeURIComponent(bank)}/graph`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  async function call(client: McpClient, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: unknown; structuredContent?: unknown };
    return { isError: res.isError === true, content: res.content, structuredContent: res.structuredContent ?? null };
  }
  const text = (r: ToolResult) => (r.content as Array<{ text: string }>)[0]?.text ?? '';

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    process.env.MEMORY_ENABLED = 'true';
    process.env.EMBEDDINGS_PROVIDER = 'stub';
    const [{ createE2eApp }, { PrismaService }, { GraphService }, { EMBEDDING_PROVIDER }] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/prisma/prisma.service.js'),
      import('../src/graph/graph.service.js'),
      import('../src/embedding/embedding.provider.js'),
    ]);
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    graph = app.get(GraphService);
    await graph.ensureSchema(app.get<{ dimension: number }>(EMBEDDING_PROVIDER).dimension);
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    for (const [i, id] of WORKSPACES.entries()) {
      await prisma.workspace.upsert({ where: { id }, update: { deletedAt: null }, create: { id, name: `Graph e2e ${'AB-'[i]} (#1008)` } });
    }
    await prisma.memoryBank.deleteMany({ where: { workspaceId: { in: WORKSPACES } } });
    for (const ws of WORKSPACES) await graph.deleteMemoryUnits(ws, (await graph.memoryUnitIds(ws)).map((v) => v.unitId));
    await prisma.workspaceSettings.upsert({ where: { workspaceId: WS_OFF }, update: { disabledFeatures: ['memory'] }, create: { workspaceId: WS_OFF, disabledFeatures: ['memory'] } });
    people.alice = await person('alice', WS_A, 'editor');
    people.carol = await person('carol', WS_B, 'editor');
    people.erin = await person('erin', WS_OFF, 'editor');
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    if (!app) return;
    await prisma.memoryBank.deleteMany({ where: { workspaceId: { in: WORKSPACES } } });
    for (const ws of WORKSPACES) await graph.deleteMemoryUnits(ws, (await graph.memoryUnitIds(ws)).map((v) => v.unitId));
    await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  it('gives the same tools and the same result for every step of the script as the reference server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'server-memory-'));
    try {
      const entry = join(dirname(createRequire(import.meta.url).resolve('@modelcontextprotocol/server-memory/package.json')), 'dist/index.js');
      const reference = await connect(
        new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...(process.env as Record<string, string>), MEMORY_FILE_PATH: join(dir, 'memory.jsonl') }, stderr: 'pipe' }),
      );
      const mine = await ours(people.alice.key, `diff-${nonce}`);

      // The tools as a client sees them: names, titles, descriptions, schemas and hints.
      const tools = async (c: McpClient) =>
        (await c.listTools()).tools.map((t) => JSON.parse(JSON.stringify(t, (k, v: unknown) => (k === '$schema' || k === 'execution' ? undefined : v))) as unknown);
      expect(await tools(mine)).toEqual(await tools(reference));

      for (const [i, [name, args]] of SCRIPT.entries()) {
        const [want, got] = [await call(reference, name, args), await call(mine, name, args)];
        expect({ step: i, name, ...got }).toEqual({ step: i, name, ...want });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  describe('one bank behind every wire', () => {
    const bank = `recall-${nonce}`;
    const hindsight = (key: string) => new HindsightClient({ baseUrl, apiKey: key, maxAttempts: 1 });

    it('recalls a graph observation through Hindsight, never on another workspace’s bank, and forgets it once deleted', async () => {
      const mcp = await ours(people.alice.key, bank);
      expect((await call(mcp, 'create_entities', { entities: [{ name: 'Gwen', entityType: 'person', observations: ['maintains the deploy pipeline'] }] })).isError).toBe(false);
      const recalled = await hindsight(people.alice.key).recall(bank, 'Who maintains the deploy pipeline?');
      const hit = recalled.results.find((r) => r.text === 'maintains the deploy pipeline');
      expect(hit).toBeDefined();
      // Stored as a fact of this workspace's bank, verbatim, with the entity as its context and its folded key linked.
      const row = await prisma.memoryUnit.findUniqueOrThrow({ where: { id: hit!.id }, include: { entities: true } });
      expect(row).toMatchObject({ workspaceId: WS_A, factType: 'world', text: 'maintains the deploy pipeline', context: 'Gwen (person)', documentId: expect.stringMatching(/^graph:[0-9a-f-]{36}:0000000001$/) });
      expect(row.entities.map((e) => e.entityKey)).toEqual(['gwen']);
      expect(await prisma.memoryRelation.count({ where: { bankId: row.bankId } })).toBe(0);

      // Carol's key is pinned to B: the same bank name there is another, empty bank.
      await expect(hindsight(people.carol.key).recall(bank, 'deploy pipeline')).rejects.toMatchObject({ statusCode: 404 });
      expect(JSON.parse(text(await call(await ours(people.carol.key, bank), 'read_graph', {})))).toEqual({ entities: [], relations: [] });

      expect(text(await call(mcp, 'delete_observations', { deletions: [{ entityName: 'Gwen', observations: ['maintains the deploy pipeline'] }] }))).toBe('Observations deleted successfully');
      expect(await prisma.memoryUnit.count({ where: { id: hit!.id } })).toBe(0);
      expect((await graph.memoryUnitIds(WS_A)).map((v) => v.unitId)).not.toContain(hit!.id);
      expect((await hindsight(people.alice.key).recall(bank, 'Who maintains the deploy pipeline?')).results.map((r) => r.text)).not.toContain('maintains the deploy pipeline');
    }, 30_000);

    it('masks a secret in an observation; the exact text of the secret deletes nothing', async () => {
      const mcp = await ours(people.alice.key, bank);
      const added = await call(mcp, 'add_observations', { observations: [{ entityName: 'Gwen', contents: ['reachable at gwen@example.com'] }] });
      expect(added.structuredContent).toEqual({ results: [{ entityName: 'Gwen', addedObservations: ['reachable at [EMAIL_1]'] }] });
      expect(text(await call(mcp, 'delete_observations', { deletions: [{ entityName: 'Gwen', observations: ['reachable at gwen@example.com'] }] }))).toBe('Deleted 0 of 1 observations.');
      expect(await prisma.memoryUnit.count({ where: { workspaceId: WS_A, text: { contains: 'gwen@example.com' } } })).toBe(0);
    }, 30_000);

    it('lets a read-only key read the graph and refuses it every write; a capture key creates but never deletes', async () => {
      const readOnly = await ours(await mintKey(people.alice.id, WS_A, 'read'), bank);
      expect((await readOnly.listTools()).tools.map((t) => t.name)).toEqual(['read_graph', 'search_nodes', 'open_nodes']);
      expect(JSON.parse(text(await call(readOnly, 'open_nodes', { names: ['Gwen'] }))).entities[0]).toMatchObject({ name: 'Gwen' });
      const writes: Step[] = [
        ['create_entities', { entities: [{ name: 'Nope', entityType: 'x', observations: [] }] }],
        ['create_relations', { relations: [] }],
        ['add_observations', { observations: [] }],
        ['delete_entities', { entityNames: ['Gwen'] }],
        ['delete_observations', { deletions: [] }],
        ['delete_relations', { relations: [] }],
      ];
      for (const [name, args] of writes) {
        const res = await call(readOnly, name, args).catch((e: Error) => ({ isError: true, content: e.message, structuredContent: null }));
        expect([name, res.isError]).toEqual([name, true]);
      }
      expect(await prisma.memoryEntity.count({ where: { workspaceId: WS_A, name: 'Nope' } })).toBe(0);

      const capture = await ours(await mintKey(people.alice.id, WS_A, 'capture'), bank);
      expect((await call(capture, 'create_entities', { entities: [{ name: 'Hugo', entityType: 'person', observations: ['reviews migrations'] }] })).isError).toBe(false);
      expect((await call(capture, 'delete_entities', { entityNames: ['Hugo'] })).isError).toBe(true);
      expect(await prisma.memoryEntity.count({ where: { workspaceId: WS_A, name: 'Hugo' } })).toBe(1);
    }, 30_000);

    it('removes a bank’s entities, relations and observations with the bank', async () => {
      const mcp = await ours(people.alice.key, bank);
      await call(mcp, 'create_relations', { relations: [{ from: 'Hugo', to: 'Gwen', relationType: 'pairs_with' }] });
      const row = await prisma.memoryBank.findUniqueOrThrow({ where: { workspaceId_bankId: { workspaceId: WS_A, bankId: bank } } });
      expect(await prisma.memoryRelation.count({ where: { bankId: row.id } })).toBe(1);
      await hindsight(people.alice.key).deleteBank(bank);
      expect(await prisma.memoryEntity.count({ where: { bankId: row.id } })).toBe(0);
      expect(await prisma.memoryRelation.count({ where: { bankId: row.id } })).toBe(0);
      expect(await prisma.memoryUnit.count({ where: { bankId: row.id } })).toBe(0);
    }, 30_000);

    it('removes a deleted workspace’s graph', async () => {
      const { WorkspaceTeardownService } = await import('../src/workspaces/workspace-teardown.service.js');
      const doomed = randomUUID();
      await prisma.workspace.create({ data: { id: doomed, name: `Graph doomed ${nonce}` } });
      const dana = await person(`dana-${nonce}`, doomed, 'editor');
      const mcp = await ours(dana.key, `gone-${nonce}`);
      await call(mcp, 'create_entities', { entities: [{ name: 'A', entityType: 't', observations: ['one'] }, { name: 'B', entityType: 't', observations: [] }] });
      await call(mcp, 'create_relations', { relations: [{ from: 'A', to: 'B', relationType: 'r' }] });
      expect(await prisma.memoryRelation.count({ where: { workspaceId: doomed } })).toBe(1);

      await prisma.workspace.update({ where: { id: doomed }, data: { deletedAt: new Date() } });
      for (let i = 0; i < 20 && !(await app.get(WorkspaceTeardownService).teardown(doomed)); i++);
      expect(await prisma.memoryEntity.count({ where: { workspaceId: doomed } })).toBe(0);
      expect(await prisma.memoryRelation.count({ where: { workspaceId: doomed } })).toBe(0);
      expect(await graph.memoryUnitIds(doomed)).toEqual([]);
      await prisma.user.delete({ where: { id: dana.id } });
    }, 30_000);
  });

  it('answers 404 with the section off or MEMORY_ENABLED off, writing nothing', async () => {
    const post = (key: string, path: string) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_entities', arguments: { entities: [{ name: 'X', entityType: 'y', observations: ['z'] }] } } }),
      });
    expect((await post(people.erin.key, `/mcp/off-${nonce}/graph`)).status).toBe(404);
    expect(await prisma.memoryEntity.count({ where: { workspaceId: WS_OFF } })).toBe(0);

    const { FeaturesService: Features } = await import('../src/auth/features.service.js');
    const unavailable = vi.spyOn(app.get<FeaturesService>(Features), 'unavailable').mockReturnValue(['memory']);
    try {
      expect((await post(people.alice.key, `/mcp/off-${nonce}/graph`)).status).toBe(404);
      for (const method of ['GET', 'DELETE']) expect((await fetch(`${baseUrl}/mcp/off-${nonce}/graph`, { method, headers: { Authorization: `Bearer ${people.alice.key}` } })).status).toBe(404);
    } finally {
      unavailable.mockRestore();
    }
    expect(await prisma.memoryBank.count({ where: { bankId: `off-${nonce}` } })).toBe(0);
  });
});
