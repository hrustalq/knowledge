import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_KEY_OK_META, READ_KEY_OK_META } from '../src/auth/access.decorator.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { MemoryMcpController } from '../src/memory/memory-mcp.controller.js';
import { buildMemoryMcpServer } from '../src/memory/memory-mcp.js';
import { MCP_TOOLSETS } from '@knowledge/contracts';

const keyed = (scope: 'read' | 'capture' | 'write'): Principal => ({ ...DEV_PRINCIPAL, mode: 'api-key', isAdmin: false, userId: 'u1', apiKey: { id: 'k1', scope, workspaceId: 'ws-1' } });
const bankRow = { id: 'bank-row', bankId: 'agent', workspaceId: 'ws-1' };

async function connect(principal: Principal, opts: { pathBank?: string | null; headerBank?: string; off?: () => boolean } = {}) {
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
  const server = buildMemoryMcpServer({ access, banks, intake, recall, reflect } as never, {
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
  return { client, call, access, banks, intake, recall, reflect };
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

  it('is a server of its own: no tool shares a name with the platform’s, and a toolset key is not admitted', () => {
    const platform = new Set(Object.values(MCP_TOOLSETS).flatMap((t) => (t as { tools: readonly string[] }).tools));
    for (const name of ['retain', 'sync_retain', 'recall', 'reflect', 'list_banks']) expect(platform.has(name)).toBe(false);
    // AuthGuard admits a key limited to toolsets only where @McpKeyOk says so; this controller must not.
    expect(Reflect.getMetadata(MCP_KEY_OK_META, MemoryMcpController)).toBeUndefined();
    expect(Reflect.getMetadata(READ_KEY_OK_META, MemoryMcpController)).toBe(true);
  });
});
