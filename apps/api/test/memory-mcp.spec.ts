import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_KEY_OK_META, READ_KEY_OK_META } from '../src/auth/access.decorator.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { MemoryMcpController } from '../src/memory/memory-mcp.controller.js';
import { buildMemoryMcpServer, isMemoryMcpProfile } from '../src/memory/memory-mcp.js';
import { MemoryRateService } from '../src/memory/memory-rate.service.js';
import { RateLimitedException } from '../src/public/public-rate-limit.js';
import { MCP_TOOLSETS } from '@knowledge/contracts';

const GRAPH_READS = ['read_graph', 'search_nodes', 'open_nodes'];
const GRAPH_TOOLS = ['create_entities', 'create_relations', 'add_observations', 'delete_entities', 'delete_observations', 'delete_relations', ...GRAPH_READS];
const keyed = (scope: 'read' | 'capture' | 'write'): Principal => ({ ...DEV_PRINCIPAL, mode: 'api-key', isAdmin: false, userId: 'u1', apiKey: { id: 'k1', scope, workspaceId: 'ws-1' } });
const bankRow = { id: 'bank-row', bankId: 'agent', workspaceId: 'ws-1' };

async function connect(principal: Principal, opts: { pathBank?: string | null; headerBank?: string; off?: () => boolean; limited?: string[] } = {}) {
  const access = {
    caller: vi.fn(async (p: Principal, _ws: unknown, role: string, o: { capture?: boolean }) => {
      if (opts.off?.()) throw new NotFoundException('The memory feature is switched off in this workspace.');
      if (role === 'editor' && p.apiKey?.scope === 'read') throw new ForbiddenException('This API key is read-only');
      return { principal: p, workspaceId: 'ws-1', role, capture: o.capture };
    }),
    bank: vi.fn(async (_caller: unknown, bankId: string) => ({ ...bankRow, bankId })),
  };
  const banks = { list: vi.fn(async () => ({ banks: [{ bank_id: 'agent', fact_count: 2 }], total: 1, limit: 100, offset: 0 })) };
  const intake = { retain: vi.fn(async (_c: unknown, _b: string, req: { async?: boolean }) => ({ success: true, async: req.async === true, operation_id: req.async ? 'op-1' : undefined })) };
  const recall = { recallForModel: vi.fn(async () => ({ text: '<memories tool="recall">\n[M1] Alice works at Google\n</memories>', results: [] })) };
  const reflect = { reflect: vi.fn(async () => ({ text: 'She is an engineer.', structured_output: { role: 'engineer' } })) };
  const rate = { check: vi.fn(async (verb: string) => { if (opts.limited?.includes(verb)) throw new RateLimitedException(`Too many ${verb} requests`, 60); }) };
  const server = buildMemoryMcpServer({ access, banks, intake, recall, reflect, rate } as never, {
    principal,
    workspaceHeader: undefined,
    pathBank: opts.pathBank === undefined ? 'agent' : opts.pathBank,
    headerBank: opts.headerBank,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: res.isError === true, text: res.content[0]?.text ?? '' };
  };
  return { client, call, access, banks, intake, recall, reflect, rate };
}

describe('per-bank memory MCP server (#986)', () => {
  it('offers a write key four tools on a bank’s endpoint, plus list_banks on the header form', async () => {
    const one = await connect(keyed('write'));
    const tools = (await one.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(['retain', 'sync_retain', 'recall', 'reflect']);
    expect(Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]))).toEqual({ retain: false, sync_retain: false, recall: true, reflect: true });
    // The bank is the URL's: no tool there takes one.
    for (const tool of tools) expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('bank_id');

    const multi = (await (await connect(keyed('write'), { pathBank: null })).client.listTools()).tools;
    expect(multi.map((t) => t.name)).toEqual(['retain', 'sync_retain', 'recall', 'reflect', 'list_banks']);
    expect(Object.keys(multi[0]!.inputSchema.properties ?? {})).toContain('bank_id');
    expect((await (await connect(keyed('capture'))).client.listTools()).tools.map((t) => t.name)).toContain('retain');
  });

  it('offers a read key only recall and reflect, and refuses a direct call of retain', async () => {
    const { client, call, intake } = await connect(keyed('read'));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['recall', 'reflect']);
    for (const name of ['retain', 'sync_retain']) {
      const refused = await call(name, { content: 'x' }).catch((e: Error) => ({ isError: true, text: e.message }));
      expect(refused.isError).toBe(true);
    }
    expect(intake.retain).not.toHaveBeenCalled();
  });

  it('hands each tool to its service, resolving the caller on execution', async () => {
    const { call, access, intake, recall, reflect } = await connect(keyed('write'));
    expect(JSON.parse((await call('retain', { content: 'Alice works at Google', tags: ['user:a'], context: 'chat' })).text)).toMatchObject({ status: 'accepted', operation_id: 'op-1' });
    expect(intake.retain).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'editor', capture: true }), 'agent', { items: [{ content: 'Alice works at Google', tags: ['user:a'], context: 'chat' }], async: true });
    expect(JSON.parse((await call('sync_retain', { content: 'x' })).text)).toMatchObject({ status: 'success' });
    expect(intake.retain).toHaveBeenLastCalledWith(expect.anything(), 'agent', { items: [{ content: 'x' }], async: false });

    const recalled = await call('recall', { query: 'What does Alice do?', tags: ['user:a'], tags_match: 'any_strict', max_tokens: 500 });
    expect(recalled.text).toMatch(/^<memories tool="recall">/);
    expect(recall.recallForModel).toHaveBeenCalledWith(expect.objectContaining({ bankId: 'agent' }), expect.objectContaining({ query: 'What does Alice do?', tags: ['user:a'], tagsMatch: 'any_strict', maxTokens: 500, budget: 'high', userId: 'u1' }), 'recall');
    expect(access.caller).toHaveBeenLastCalledWith(expect.anything(), undefined, 'viewer', { capture: false });

    expect((await call('reflect', { query: 'What does Alice do?' })).text).toBe('She is an engineer.');
    expect(reflect.reflect).toHaveBeenLastCalledWith(expect.objectContaining({ bankId: 'agent' }), expect.objectContaining({ query: 'What does Alice do?', budget: 'low', userId: 'u1' }));
    expect(JSON.parse((await call('reflect', { query: 'q', response_schema: { type: 'object' } })).text)).toEqual({ text: 'She is an engineer.', structured_output: { role: 'engineer' }, structured_output_error: null });
  });

  it('on the header form takes the bank from the tool, then the header, then "default"', async () => {
    const withHeader = await connect(keyed('write'), { pathBank: null, headerBank: 'from-header' });
    await withHeader.call('recall', { query: 'q' });
    expect(withHeader.access.bank).toHaveBeenLastCalledWith(expect.anything(), 'from-header');
    await withHeader.call('recall', { query: 'q', bank_id: 'named' });
    expect(withHeader.access.bank).toHaveBeenLastCalledWith(expect.anything(), 'named');
    const bare = await connect(keyed('write'), { pathBank: null });
    await bare.call('sync_retain', { content: 'x' });
    expect(bare.intake.retain).toHaveBeenLastCalledWith(expect.anything(), 'default', expect.anything());
    expect(JSON.parse((await bare.call('list_banks', { query: 'ag' })).text)).toMatchObject({ banks: [{ bank_id: 'agent' }], total: 1 });
    expect(bare.banks.list).toHaveBeenCalledWith(expect.anything(), { q: 'ag', limit: undefined, offset: undefined });
  });

  it('refuses a call made after the section was switched off, though the tool was listed', async () => {
    let off = false;
    const { client, call, recall, intake } = await connect(keyed('write'), { off: () => off });
    expect((await client.listTools()).tools).toHaveLength(4);
    off = true;
    for (const [name, args] of [['recall', { query: 'q' }], ['reflect', { query: 'q' }], ['sync_retain', { content: 'x' }], ['retain', { content: 'x' }]] as const) {
      const res = await call(name, args);
      expect([name, res.isError]).toEqual([name, true]);
      expect(res.text).toMatch(/switched off/);
    }
    expect(recall.recallForModel).not.toHaveBeenCalled();
    expect(intake.retain).not.toHaveBeenCalled();
  });

  it('refuses recall and reflect over their rate, after the resolver and before the work', async () => {
    const { call, recall, reflect, rate, access } = await connect(keyed('read'), { limited: ['recall', 'reflect'] });
    for (const name of ['recall', 'reflect']) {
      const res = await call(name, { query: 'q' });
      expect([name, res.isError, res.text]).toEqual([name, true, `Too many ${name} requests`]);
    }
    expect(rate.check.mock.calls.map((c) => c[0])).toEqual(['recall', 'reflect']);
    expect(access.bank).toHaveBeenCalledTimes(2);
    expect(recall.recallForModel).not.toHaveBeenCalled();
    expect(reflect.reflect).not.toHaveBeenCalled();
  });

  it('counts each verb per key, and fails closed only for reflect', async () => {
    const hit = vi.fn(async () => true);
    const svc = new MemoryRateService({ hit } as never, { get: (k: string) => ({ MEMORY_RETAIN_RATE_PER_MIN: 120, MEMORY_RECALL_RATE_PER_MIN: 300, MEMORY_REFLECT_RATE_PER_MIN: 30 })[k] } as never);
    for (const verb of ['retain', 'recall', 'reflect'] as const) await svc.check(verb, keyed('write'));
    await svc.check('recall', { ...keyed('write'), apiKey: undefined });
    expect(hit.mock.calls).toEqual([
      ['memory:retain:k1', 120, 60_000, true],
      ['memory:recall:k1', 300, 60_000, true],
      ['memory:reflect:k1', 30, 60_000, false],
      ['memory:recall:u1', 300, 60_000, true],
    ]);
    hit.mockResolvedValueOnce(false);
    await expect(svc.check('reflect', keyed('read'))).rejects.toMatchObject({ status: 429, retryAfterSec: 60 });
  });

  it('is a server of its own: no tool shares a name with the platform’s, and a toolset key is not admitted', () => {
    const platform = new Set(Object.values(MCP_TOOLSETS).flatMap((t) => (t as { tools: readonly string[] }).tools));
    for (const name of ['retain', 'sync_retain', 'recall', 'reflect', 'list_banks', ...GRAPH_TOOLS]) expect(platform.has(name)).toBe(false);
    // AuthGuard admits a key limited to toolsets only where @McpKeyOk says so; this controller must not.
    expect(Reflect.getMetadata(MCP_KEY_OK_META, MemoryMcpController)).toBeUndefined();
    expect(Reflect.getMetadata(READ_KEY_OK_META, MemoryMcpController)).toBe(true);
  });

  it('routes a profile by name: unknown is a 404 after the resolver, before any server is built (#1007)', async () => {
    let off = false;
    const access = { caller: vi.fn(async () => { if (off) throw new NotFoundException('The memory feature is switched off in this workspace.'); return {}; }) };
    const controller = new MemoryMcpController(access as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    const res = { on: vi.fn(), status: vi.fn(), headersSent: false };
    await expect(controller.profile(keyed('write'), undefined, 'agent', 'nope', {} as never, res as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(res.on).not.toHaveBeenCalled();
    off = true;
    await expect(controller.profile(keyed('write'), undefined, 'agent', 'nope', {} as never, res as never)).rejects.toThrow(/switched off/);
    expect(isMemoryMcpProfile('hindsight')).toBe(true);
    expect(isMemoryMcpProfile('constructor')).toBe(false);
  });
});

describe('the graph profile: the MCP reference memory server’s tools (#1008)', () => {
  async function connectGraph(principal: Principal, opts: { capped?: boolean } = {}) {
    const access = {
      caller: vi.fn(async (p: Principal, _ws: unknown, role: string, o?: { capture?: boolean }) => {
        if (role === 'editor' && p.apiKey?.scope === 'read') throw new ForbiddenException('This API key is read-only');
        if (role === 'editor' && p.apiKey?.scope === 'capture' && !o?.capture) throw new ForbiddenException('A capture key cannot do this');
        return { principal: p, workspaceId: 'ws-1', role, capture: o?.capture === true };
      }),
    };
    const entity = { name: 'Alice', entityType: 'person', observations: ['works at Acme'] };
    const read = { graph: { entities: [entity], relations: [] }, capped: opts.capped === true };
    const graph = {
      createEntities: vi.fn(async () => ({ created: [entity], skipped: ['Bob'] })),
      createRelations: vi.fn(async () => [{ from: 'Alice', to: 'Acme', relationType: 'works_at' }]),
      addObservations: vi.fn(async () => [{ entityName: 'Alice', addedObservations: ['likes tea'] }]),
      deleteEntities: vi.fn(async () => 'Entities deleted successfully'),
      deleteObservations: vi.fn(async () => 'Observations deleted successfully'),
      deleteRelations: vi.fn(async () => 'Relations deleted successfully'),
      read: vi.fn(async () => read),
      search: vi.fn(async () => read),
      open: vi.fn(async () => read.graph),
    };
    const server = buildMemoryMcpServer({ access, graph } as never, { principal, workspaceHeader: undefined, pathBank: 'agent', headerBank: undefined }, 'graph');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'spec', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ text: e.message }] }))) as {
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent?: unknown;
      };
    return { client, call, access, graph };
  }

  it('offers a write or capture key all nine tools, and a read key only the three reads', async () => {
    for (const scope of ['write', 'capture'] as const) expect((await (await connectGraph(keyed(scope))).client.listTools()).tools.map((t) => t.name)).toEqual(GRAPH_TOOLS);
    const { client, call, graph } = await connectGraph(keyed('read'));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(GRAPH_READS);
    expect((await call('create_entities', { entities: [] })).isError).toBe(true);
    expect(graph.createEntities).not.toHaveBeenCalled();
  });

  it('resolves each tool’s role on execution: a capture key creates and adds, only an editor deletes', async () => {
    const { call, access, graph } = await connectGraph(keyed('capture'));
    await call('create_entities', { entities: [] });
    expect(access.caller).toHaveBeenLastCalledWith(expect.anything(), undefined, 'editor', { capture: true });
    expect(graph.createEntities).toHaveBeenCalledWith(expect.objectContaining({ capture: true }), 'agent', []);
    await call('add_observations', { observations: [] });
    await call('create_relations', { relations: [] });
    expect(graph.addObservations).toHaveBeenCalled();
    expect(graph.createRelations).toHaveBeenCalled();
    for (const [name, args] of [['delete_entities', { entityNames: ['A'] }], ['delete_observations', { deletions: [] }], ['delete_relations', { relations: [] }]] as const) {
      expect([name, (await call(name, args)).isError]).toEqual([name, true]);
    }
    expect(graph.deleteEntities).not.toHaveBeenCalled();
    await call('open_nodes', { names: ['Alice'] });
    expect(access.caller).toHaveBeenLastCalledWith(expect.anything(), undefined, 'viewer', undefined);
  });

  it('answers in the reference’s shapes: indented JSON, a skipped notice beside it, a message for a delete', async () => {
    const { call } = await connectGraph(keyed('write'));
    const created = await call('create_entities', { entities: [] });
    expect(created.content.map((c) => c.text)).toEqual([
      JSON.stringify([{ name: 'Alice', entityType: 'person', observations: ['works at Acme'] }], null, 2),
      'Skipped 1 entity that already exists: Bob. Its observations were not added; use add_observations for existing entities.',
    ]);
    expect(created.structuredContent).toEqual({ entities: [{ name: 'Alice', entityType: 'person', observations: ['works at Acme'] }], skipped: ['Bob'] });
    expect((await call('add_observations', { observations: [] })).structuredContent).toEqual({ results: [{ entityName: 'Alice', addedObservations: ['likes tea'] }] });
    const deleted = await call('delete_relations', { relations: [] });
    expect(deleted.content).toEqual([{ type: 'text', text: 'Relations deleted successfully' }]);
    expect(deleted.structuredContent).toEqual({ success: true, message: 'Relations deleted successfully' });
  });

  it('says beside a read when this server’s ceiling cut it, and changes nothing else', async () => {
    const plain = await (await connectGraph(keyed('read'))).call('read_graph', {});
    expect(plain.content).toHaveLength(1);
    const { call } = await connectGraph(keyed('read'), { capped: true });
    for (const [name, args] of [['read_graph', {}], ['search_nodes', { query: 'a' }]] as const) {
      const res = await call(name, args);
      expect(res.content[0]!.text).toBe(plain.content[0]!.text);
      expect(res.content[1]!.text).toMatch(/^Showing only the first 1 entities: this server returns at most 1 per call\./);
      expect(res.structuredContent).toEqual(plain.structuredContent);
    }
  });
});

describe('the files profile: the Anthropic memory tool as one MCP tool (#1009)', () => {
  async function connectFiles(principal: Principal) {
    const access = {
      caller: vi.fn(async (p: Principal, _ws: unknown, role: string, o?: { capture?: boolean }) => {
        if (role === 'editor' && p.apiKey?.scope === 'read') throw new ForbiddenException('This API key is read-only');
        if (role === 'editor' && p.apiKey?.scope === 'capture' && !o?.capture) throw new ForbiddenException('A capture key cannot do this');
        return { principal: p, workspaceId: 'ws-1', role };
      }),
      find: vi.fn(async () => null),
    };
    const rate = { check: vi.fn(async () => undefined) };
    const banks = { ensure: vi.fn(async () => { throw new Error('nothing may be written in this spec'); }) };
    const { MemoryFilesService } = await import('../src/memory/memory-files.service.js');
    const config = { get: (k: string) => (k === 'MEMORY_RETAIN_MAX_CHARS' ? 50_000 : 100) };
    const files = new MemoryFilesService({} as never, access as never, banks as never, {} as never, {} as never, rate as never, config as never);
    const server = buildMemoryMcpServer({ access, files } as never, { principal, workspaceHeader: undefined, pathBank: 'agent', headerBank: undefined }, 'files');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'spec', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const res = (await client.callTool({ name: 'memory', arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { isError: res.isError === true, text: res.content[0]?.text ?? '' };
    };
    return { client, call, access, rate, banks };
  }

  it('offers one tool named memory to every key, a read-only one included', async () => {
    for (const scope of ['read', 'capture', 'write'] as const) {
      const tools = (await (await connectFiles(keyed(scope))).client.listTools()).tools;
      expect(tools.map((t) => t.name)).toEqual(['memory']);
      expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(['command', 'path', 'view_range', 'file_text', 'old_str', 'new_str', 'insert_line', 'insert_text', 'old_path', 'new_path']);
    }
  });

  it('resolves each command’s role on execution and spends the recall rate on a view, the retain rate on a write', async () => {
    const { call, access, rate } = await connectFiles(keyed('write'));
    // An empty bank: the root listing, never an error.
    expect(await call({ command: 'view', path: '/memories' })).toEqual({
      isError: false,
      text: "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n4.0K\t/memories",
    });
    expect(access.caller).toHaveBeenLastCalledWith(expect.anything(), undefined, 'viewer', { capture: undefined });
    expect(rate.check).toHaveBeenLastCalledWith('recall', expect.anything());
    expect(await call({ command: 'delete', path: '/memories/x' })).toEqual({ isError: true, text: 'Error: The path /memories/x does not exist' });
    expect(access.caller).toHaveBeenLastCalledWith(expect.anything(), undefined, 'editor', { capture: undefined });
    expect(rate.check).toHaveBeenLastCalledWith('retain', expect.anything());
  });

  it('refuses a traversal on every command before a bank is read', async () => {
    const { call, access, banks } = await connectFiles(keyed('write'));
    const bad = '/memories/../etc/passwd';
    const inputs = [
      { command: 'view', path: bad },
      { command: 'create', path: bad, file_text: 'x' },
      { command: 'str_replace', path: bad, old_str: 'a', new_str: 'b' },
      { command: 'insert', path: bad, insert_line: 0, insert_text: 'x' },
      { command: 'delete', path: bad },
      { command: 'rename', old_path: bad, new_path: '/memories/ok' },
      { command: 'rename', old_path: '/memories/ok', new_path: bad },
    ];
    for (const input of inputs) expect([input.command, await call(input)]).toEqual([input.command, { isError: true, text: `Error: Path ${bad} would escape /memories directory` }]);
    expect(access.find).not.toHaveBeenCalled();
    expect(banks.ensure).not.toHaveBeenCalled();
  });

  it('lets a read-only key view and refuses it every write; a capture key may create but not delete', async () => {
    const readOnly = await connectFiles(keyed('read'));
    expect((await readOnly.call({ command: 'view', path: '/memories' })).isError).toBe(false);
    for (const command of ['create', 'str_replace', 'insert', 'delete', 'rename']) {
      const res = await readOnly.call({ command, path: '/memories/a', file_text: 'x', old_str: 'x', insert_line: 0, insert_text: 'x', old_path: '/memories/a', new_path: '/memories/b' });
      expect([command, res.isError, res.text]).toEqual([command, true, 'This API key is read-only']);
    }
    const capture = await connectFiles(keyed('capture'));
    expect((await capture.call({ command: 'delete', path: '/memories/a' })).text).toBe('A capture key cannot do this');
    expect(capture.access.caller).toHaveBeenLastCalledWith(expect.anything(), undefined, 'editor', { capture: undefined });
  });
});
