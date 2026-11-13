import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { runRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { BetaLocalFilesystemMemoryTool } from '@anthropic-ai/sdk/tools/memory/node';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FeaturesService } from '../src/auth/features.service.js';
import type { GraphService } from '../src/graph/graph.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #1009 acceptance, end to end against live infra: the SDK's
 * `BetaLocalFilesystemMemoryTool` (`@anthropic-ai/sdk` 1.8.0, pinned) runs on a
 * temporary directory through the SDK's own tool runner, this API serves
 * `POST /v1/default/banks/<bank>/memory-tool` and `/mcp/<bank>/files`, and one
 * sequence of commands runs against all three. Every result must be equal,
 * after one normalisation: a directory's size (the SDK shows the filesystem's,
 * this store always `4.0K`).
 *
 * The sequence keeps to the commands where the two are meant to agree; each
 * documented difference (`create` overwrites, `..` resolving inside, encoded
 * or backslashed traversal, empty directories, images) has a test of its own.
 *
 * Forces `AUTH_MODE=api-key` and makes its own people, none a platform admin:
 *   alice — editor of A;  carol — editor of B;  erin — editor of OFF (section off)
 *
 * Embeddings are the stub provider and no model is routed: nothing is called.
 *
 * Needs `make infra-up`. Not part of `make verify`:
 * `pnpm --filter @knowledge/api run test:e2e memory-files-compat`.
 */

const WS_A = '10090000-0000-4009-8009-00000000000a';
const WS_B = '10090000-0000-4009-8009-00000000000b';
const WS_OFF = '10090000-0000-4009-8009-00000000000c';
const WORKSPACES = [WS_A, WS_B, WS_OFF];

type Person = { id: string; key: string };
type Input = Record<string, unknown>;
type Result = { content: string; is_error: boolean };

/** The sequence every implementation runs: every command, every documented error, the listing rules. */
const SEQUENCE: Input[] = [
  { command: 'view', path: '/memories' },
  { command: 'view', path: '/memories/nothing.md' },
  { command: 'create', path: '/memories/notes.md', file_text: 'line one\nline two\nline three\n' },
  { command: 'create', path: '/memories/projects/alpha/plan.md', file_text: 'goal: ship the importer\nowner: alice\nstatus: draft' },
  { command: 'create', path: '/memories/projects/beta.md', file_text: 'beta notes — café ✓' },
  { command: 'create', path: '/memories/.hidden', file_text: 'not listed' },
  { command: 'create', path: '/memories/projects/alpha/deep/x.md', file_text: 'three levels down' },
  { command: 'create', path: '/memories/node_modules/pkg.md', file_text: 'skipped' },
  { command: 'create', path: '/memories/projects', file_text: 'a directory is in the way' },
  { command: 'view', path: '/memories' },
  { command: 'view', path: '/memories/projects' },
  { command: 'view', path: '/memories/projects/' },
  { command: 'view', path: '/memories/.hidden' },
  { command: 'view', path: '/memories/notes.md' },
  { command: 'view', path: '/memories/notes.md', view_range: [2, -1] },
  { command: 'view', path: '/memories/notes.md', view_range: [1, 2] },
  { command: 'view', path: '/memories/notes.md', view_range: [0, 99] },
  { command: 'str_replace', path: '/memories/notes.md', old_str: 'line two', new_str: 'line 2' },
  { command: 'str_replace', path: '/memories/notes.md', old_str: 'missing', new_str: 'x' },
  { command: 'str_replace', path: '/memories/notes.md', old_str: 'line', new_str: 'x' },
  { command: 'str_replace', path: '/memories/projects', old_str: 'a', new_str: 'b' },
  { command: 'str_replace', path: '/memories/ghost.md', old_str: 'a', new_str: 'b' },
  { command: 'str_replace', path: '/memories/projects/alpha/plan.md', old_str: 'status: draft', new_str: 'status: in review' },
  { command: 'insert', path: '/memories/notes.md', insert_line: 0, insert_text: 'top\n' },
  { command: 'insert', path: '/memories/notes.md', insert_line: 5, insert_text: 'end' },
  { command: 'insert', path: '/memories/notes.md', insert_line: 2, insert_text: 'a\nb' },
  { command: 'insert', path: '/memories/notes.md', insert_line: 99, insert_text: 'x' },
  { command: 'insert', path: '/memories/projects', insert_line: 0, insert_text: 'x' },
  { command: 'insert', path: '/memories/ghost.md', insert_line: 0, insert_text: 'x' },
  { command: 'view', path: '/memories/notes.md' },
  { command: 'rename', old_path: '/memories/projects/beta.md', new_path: '/memories/archive/beta.md' },
  { command: 'rename', old_path: '/memories/notes.md', new_path: '/memories/archive/beta.md' },
  { command: 'rename', old_path: '/memories/ghost.md', new_path: '/memories/ghost2.md' },
  { command: 'rename', old_path: '/memories', new_path: '/memories/elsewhere' },
  { command: 'rename', old_path: '/memories/projects', new_path: '/memories/work' },
  { command: 'view', path: '/memories' },
  { command: 'view', path: '/memories/work/alpha/plan.md' },
  { command: 'delete', path: '/memories/archive' },
  { command: 'delete', path: '/memories' },
  { command: 'delete', path: '/memories/ghost.md' },
  { command: 'delete', path: '/memories/work/alpha/deep' },
  { command: 'delete', path: '/memories/node_modules/pkg.md' },
  { command: 'view', path: '/memories' },
  // Refused paths both refuse in the same words.
  ...['/etc/passwd', 'memories/notes.md', '/memories/../secrets.env', '/memories/work/../../etc'].flatMap((bad): Input[] => [
    { command: 'view', path: bad },
    { command: 'create', path: bad, file_text: 'x' },
    { command: 'str_replace', path: bad, old_str: 'a', new_str: 'b' },
    { command: 'insert', path: bad, insert_line: 0, insert_text: 'x' },
    { command: 'delete', path: bad },
    { command: 'rename', old_path: bad, new_path: '/memories/ok.md' },
    { command: 'rename', old_path: '/memories/work/alpha/plan.md', new_path: bad },
  ]),
  { command: 'teleport', path: '/memories' },
  { command: 'view', path: '/memories' },
];

/** A listing's directory lines carry the store's own size for a directory: the one thing compared loosely. */
function normalise(r: Result): Result {
  if (!r.content.startsWith("Here're the files and directories")) return r;
  const lines = r.content.split('\n').map((line, i) => (i === 1 || line.endsWith('/') ? line.replace(/^[^\t]+\t/, '<dir>\t') : line));
  return { ...r, content: lines.join('\n') };
}

describe('Anthropic memory tool compatibility (e2e, #1009)', () => {
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
      data: { userId, name: `files e2e ${nonce}`, keyHash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 11), scope, workspaceId },
    });
    keyIds.push(row.id);
    return key;
  }

  async function person(name: string, workspaceId: string, role: 'admin' | 'editor' | 'viewer'): Promise<Person> {
    const email = `files-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Files ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId, userId: user.id } }, update: { role }, create: { workspaceId, userId: user.id, role } });
    return { id: user.id, key: await mintKey(user.id, workspaceId) };
  }

  const post = (key: string, bank: string, input: unknown) =>
    fetch(`${baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memory-tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  async function rest(key: string, bank: string, input: unknown): Promise<Result> {
    const res = await post(key, bank, input);
    expect(res.status).toBe(200);
    return (await res.json()) as Result;
  }

  async function filesMcp(key: string, bank: string): Promise<(input: Input) => Promise<Result>> {
    const client = new McpClient({ name: 'files-compat', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${encodeURIComponent(bank)}/files`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    clients.push(client);
    return async (input) => {
      const res = (await client.callTool({ name: 'memory', arguments: input })) as { isError?: boolean; content: Array<{ text: string }> };
      return { content: res.content.map((c) => c.text).join(''), is_error: res.isError === true };
    };
  }

  const bankRow = (workspaceId: string, bankId: string) => prisma.memoryBank.findUnique({ where: { workspaceId_bankId: { workspaceId, bankId } } });
  const hindsight = (key: string) => new HindsightClient({ baseUrl, apiKey: key, maxAttempts: 1 });

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    process.env.MEMORY_ENABLED = 'true';
    process.env.EMBEDDINGS_PROVIDER = 'stub';
    // The sequence runs ~150 writes through one key in well under a minute.
    process.env.MEMORY_RETAIN_RATE_PER_MIN = '100000';
    process.env.MEMORY_RECALL_RATE_PER_MIN = '100000';
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
      await prisma.workspace.upsert({ where: { id }, update: { deletedAt: null }, create: { id, name: `Files e2e ${'AB-'[i]} (#1009)` } });
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

  it('answers every command of the sequence as the SDK’s filesystem handler does, over REST and over MCP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-tool-'));
    try {
      const tool = betaMemoryTool(await BetaLocalFilesystemMemoryTool.init(dir));
      const reference = async (input: Input): Promise<Result> => {
        const out = await runRunnableTool(tool, input, {} as never);
        return { content: out.content as string, is_error: out.isError };
      };
      const mcp = await filesMcp(people.alice.key, `diff-mcp-${nonce}`);
      for (const [i, input] of SEQUENCE.entries()) {
        const want = normalise(await reference(input));
        const [viaRest, viaMcp] = [normalise(await rest(people.alice.key, `diff-${nonce}`, input)), normalise(await mcp(input))];
        expect({ step: i, input, ...viaRest }).toEqual({ step: i, input, ...want });
        // MCP checks `command` against its enum before the tool runs: an unknown one is a protocol error there.
        if (input.command !== 'teleport') expect({ step: i, input, ...viaMcp }).toEqual({ step: i, input, ...want });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('refuses ../, ..\\, %2e%2e%2f and a path outside /memories on all six commands, writing nothing', async () => {
    const bank = `refuse-${nonce}`;
    const bad = ['/memories/../x.md', '/memories/..\\x.md', '/memories/%2e%2e%2fx.md', '/memories/a/../b.md', '/tmp/x.md', '/memoriesX/x.md'];
    for (const path of bad) {
      for (const input of [
        { command: 'view', path },
        { command: 'create', path, file_text: 'x' },
        { command: 'str_replace', path, old_str: 'a', new_str: 'b' },
        { command: 'insert', path, insert_line: 0, insert_text: 'x' },
        { command: 'delete', path },
        { command: 'rename', old_path: path, new_path: '/memories/ok.md' },
        { command: 'rename', old_path: '/memories/ok.md', new_path: path },
      ]) {
        const res = await rest(people.alice.key, bank, input);
        expect([input, res.is_error, res.content]).toEqual([input, true, expect.stringMatching(/^Error: Path (must start with \/memories, got: |\S+ would escape \/memories directory$)/)]);
      }
    }
    expect(await bankRow(WS_A, bank)).toBeNull();
    expect(await prisma.memoryFile.count({ where: { workspaceId: WS_A, path: { contains: 'x.md' } } })).toBe(0);
  }, 60_000);

  it('differs from the SDK where documented: create overwrites, an emptied directory is gone, images are refused, long views stop', async () => {
    const call = (input: Input) => rest(people.alice.key, `diffs-${nonce}`, input);
    await call({ command: 'create', path: '/memories/a.md', file_text: 'first' });
    expect(await call({ command: 'create', path: '/memories/a.md', file_text: 'second' })).toEqual({ content: 'File created successfully at: /memories/a.md', is_error: false });
    expect((await call({ command: 'view', path: '/memories/a.md' })).content).toBe("Here's the content of /memories/a.md with line numbers:\n     1\tsecond");

    await call({ command: 'create', path: '/memories/dir/only.md', file_text: 'x' });
    await call({ command: 'delete', path: '/memories/dir/only.md' });
    expect(await call({ command: 'view', path: '/memories/dir' })).toEqual({ content: 'Error: The path /memories/dir does not exist. Please provide a valid path.', is_error: true });

    expect(await call({ command: 'create', path: '/memories/pic.PNG', file_text: 'x' })).toEqual({ content: 'Error: /memories/pic.PNG is an image file. This memory store holds text files only', is_error: true });
    expect(await call({ command: 'create', path: '/memories/a.md/b.md', file_text: 'x' })).toEqual({ content: 'Error: Cannot write /memories/a.md/b.md: /memories/a.md is a file', is_error: true });

    // Multi-line old_str matches, and new_str may be left out.
    await call({ command: 'create', path: '/memories/m.md', file_text: 'one\ntwo\nthree' });
    expect((await call({ command: 'str_replace', path: '/memories/m.md', old_str: 'one\ntwo\n' })).is_error).toBe(false);
    expect((await call({ command: 'view', path: '/memories/m.md' })).content).toBe("Here's the content of /memories/m.md with line numbers:\n     1\tthree");

    await call({ command: 'create', path: '/memories/big.md', file_text: Array.from({ length: 300 }, () => 'x'.repeat(99)).join('\n') });
    expect((await call({ command: 'view', path: '/memories/big.md' })).content).toMatch(/\n\[Truncated: past 16,000 characters the view stops at line 160 of 300\. Use view_range to read from line 161\.\]$/);
    expect(await call({ command: 'create', path: '/memories/huge.md', file_text: 'y'.repeat(50_001) })).toEqual({ content: 'Error: File /memories/huge.md would hold 50001 characters; the limit is 50000', is_error: true });
  }, 60_000);

  describe('one bank behind every wire', () => {
    const bank = `recall-${nonce}`;
    const unitsOf = async (path: string) => prisma.memoryUnit.findMany({ where: { workspaceId: WS_A, documentId: `file:${path}` } });

    it('recalls a file after create, recalls the change after str_replace, moves it on rename and forgets it after delete; consolidation never claims it', async () => {
      const call = (input: Input) => rest(people.alice.key, bank, input);
      const recalled = async (query: string) => (await hindsight(people.alice.key).recall(bank, query)).results.map((r) => r.text);

      await call({ command: 'create', path: '/memories/deploys.md', file_text: '# Deploys\nThe deploy pipeline is owned by Gwen.\nRollbacks need a second approver.' });
      expect(await recalled('Who owns the deploy pipeline?')).toContainEqual(expect.stringContaining('owned by Gwen'));
      const [chunk] = await unitsOf('/memories/deploys.md');
      expect(chunk).toMatchObject({ factType: 'world', context: '/memories/deploys.md', metadata: { file: '/memories/deploys.md' } });
      expect(chunk!.consolidatedAt).not.toBeNull();

      await call({ command: 'str_replace', path: '/memories/deploys.md', old_str: 'owned by Gwen', new_str: 'owned by Hugo' });
      const after = await recalled('Who owns the deploy pipeline?');
      expect(after).toContainEqual(expect.stringContaining('owned by Hugo'));
      expect(after.join('\n')).not.toContain('owned by Gwen');
      expect(await prisma.memoryUnit.count({ where: { id: chunk!.id } })).toBe(0);

      // A fact retained the Hindsight way sits beside the file: consolidation claims it, never the file's chunks.
      await hindsight(people.alice.key).retain(bank, 'Gwen moved to the data team in October.');
      const row = (await bankRow(WS_A, bank))!;
      const { MemoryConsolidationService } = await import('../src/memory/memory-consolidation.service.js');
      const consolidation = app.get(MemoryConsolidationService) as unknown as { claim(bankId: string, now: number): Promise<Array<{ documentId: string; text: string }>> };
      const claimed = await consolidation.claim(row.id, Date.now());
      expect(claimed.map((f) => f.text)).toEqual(['Gwen moved to the data team in October.']);
      expect(claimed.some((f) => f.documentId.startsWith('file:'))).toBe(false);
      expect(await prisma.memoryUnit.count({ where: { bankId: row.id, documentId: { startsWith: 'file:' }, consolidatedAt: null } })).toBe(0);

      await call({ command: 'rename', old_path: '/memories/deploys.md', new_path: '/memories/ops/deploys.md' });
      expect(await unitsOf('/memories/deploys.md')).toEqual([]);
      expect((await unitsOf('/memories/ops/deploys.md')).map((u) => u.context)).toEqual(['/memories/ops/deploys.md']);

      // An emptied file keeps no chunk; a delete takes the rows and the vectors.
      await call({ command: 'create', path: '/memories/blank.md', file_text: 'soon empty' });
      await call({ command: 'create', path: '/memories/blank.md', file_text: '\n' });
      expect(await unitsOf('/memories/blank.md')).toEqual([]);
      const ids = (await unitsOf('/memories/ops/deploys.md')).map((u) => u.id);
      expect((await call({ command: 'delete', path: '/memories/ops' })).content).toBe('Successfully deleted /memories/ops');
      expect(await prisma.memoryUnit.count({ where: { id: { in: ids } } })).toBe(0);
      expect((await graph.memoryUnitIds(WS_A)).map((v) => v.unitId)).not.toEqual(expect.arrayContaining(ids));
      expect((await recalled('Who owns the deploy pipeline?')).join('\n')).not.toContain('owned by Hugo');
    }, 60_000);

    it('masks a secret on write; the secret’s own text replaces nothing', async () => {
      const call = (input: Input) => rest(people.alice.key, bank, input);
      await call({ command: 'create', path: '/memories/contacts.md', file_text: 'Gwen: gwen@example.com' });
      expect((await call({ command: 'view', path: '/memories/contacts.md' })).content).toBe("Here's the content of /memories/contacts.md with line numbers:\n     1\tGwen: [EMAIL_1]");
      expect(await call({ command: 'str_replace', path: '/memories/contacts.md', old_str: 'gwen@example.com', new_str: 'x' })).toEqual({
        content: 'Error: No replacement was performed, old_str `gwen@example.com` did not appear verbatim in /memories/contacts.md.',
        is_error: true,
      });
      expect(await prisma.memoryFile.count({ where: { workspaceId: WS_A, content: { contains: 'gwen@example.com' } } })).toBe(0);
      expect(await prisma.memoryUnit.count({ where: { workspaceId: WS_A, text: { contains: 'gwen@example.com' } } })).toBe(0);
    }, 30_000);

    it('never shows a file to another workspace: its key on the same bank name sees an empty store and recalls nothing', async () => {
      expect(await rest(people.carol.key, bank, { command: 'view', path: '/memories' })).toEqual({
        content: "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n4.0K\t/memories",
        is_error: false,
      });
      expect(await rest(people.carol.key, bank, { command: 'view', path: '/memories/contacts.md' })).toMatchObject({ is_error: true });
      await expect(hindsight(people.carol.key).recall(bank, 'Gwen')).rejects.toMatchObject({ statusCode: 404 });
    }, 30_000);

    it('lets a read-only key view and refuses it every write; a capture key creates but never deletes', async () => {
      const readKey = await mintKey(people.alice.id, WS_A, 'read');
      expect((await rest(readKey, bank, { command: 'view', path: '/memories/contacts.md' })).is_error).toBe(false);
      for (const input of [
        { command: 'create', path: '/memories/nope.md', file_text: 'x' },
        { command: 'str_replace', path: '/memories/contacts.md', old_str: 'Gwen', new_str: 'x' },
        { command: 'insert', path: '/memories/contacts.md', insert_line: 0, insert_text: 'x' },
        { command: 'delete', path: '/memories/contacts.md' },
        { command: 'rename', old_path: '/memories/contacts.md', new_path: '/memories/c.md' },
      ]) {
        expect([input.command, (await post(readKey, bank, input)).status]).toEqual([input.command, 403]);
      }
      const viaMcp = await filesMcp(readKey, bank);
      expect((await viaMcp({ command: 'view', path: '/memories' })).is_error).toBe(false);
      expect((await viaMcp({ command: 'delete', path: '/memories/contacts.md' })).is_error).toBe(true);
      // Nothing moved: the two files the earlier tests left, as they left them.
      expect(await prisma.memoryFile.findMany({ where: { workspaceId: WS_A, bank: { bankId: bank } }, select: { path: true, content: true }, orderBy: { path: 'asc' } })).toEqual([
        { path: '/memories/blank.md', content: '\n' },
        { path: '/memories/contacts.md', content: 'Gwen: [EMAIL_1]' },
      ]);

      const captureKey = await mintKey(people.alice.id, WS_A, 'capture');
      expect((await rest(captureKey, bank, { command: 'create', path: '/memories/captured.md', file_text: 'from a capture key' })).is_error).toBe(false);
      expect((await post(captureKey, bank, { command: 'delete', path: '/memories/captured.md' })).status).toBe(403);
      expect(await prisma.memoryFile.count({ where: { workspaceId: WS_A, path: '/memories/captured.md' } })).toBe(1);
    }, 30_000);

    it('removes a bank’s files with the bank', async () => {
      const row = (await bankRow(WS_A, bank))!;
      expect(await prisma.memoryFile.count({ where: { bankId: row.id } })).toBeGreaterThan(0);
      await hindsight(people.alice.key).deleteBank(bank);
      expect(await prisma.memoryFile.count({ where: { bankId: row.id } })).toBe(0);
      expect(await prisma.memoryUnit.count({ where: { bankId: row.id } })).toBe(0);
    }, 30_000);

    it('removes a deleted workspace’s files', async () => {
      const { WorkspaceTeardownService } = await import('../src/workspaces/workspace-teardown.service.js');
      const doomed = randomUUID();
      await prisma.workspace.create({ data: { id: doomed, name: `Files doomed ${nonce}` } });
      const dana = await person(`dana-${nonce}`, doomed, 'editor');
      await rest(dana.key, `gone-${nonce}`, { command: 'create', path: '/memories/a/b.md', file_text: 'goes with the workspace' });
      expect(await prisma.memoryFile.count({ where: { workspaceId: doomed } })).toBe(1);

      await prisma.workspace.update({ where: { id: doomed }, data: { deletedAt: new Date() } });
      for (let i = 0; i < 20 && !(await app.get(WorkspaceTeardownService).teardown(doomed)); i++);
      expect(await prisma.memoryFile.count({ where: { workspaceId: doomed } })).toBe(0);
      expect(await graph.memoryUnitIds(doomed)).toEqual([]);
      await prisma.user.delete({ where: { id: dana.id } });
    }, 30_000);
  });

  describe('the bank page’s routes (#1010)', () => {
    const bank = `page-${nonce}`;
    let vera: Person;
    let admin: Person;
    let bankRowId: string;
    const web = (key: string, method: string, path: string) => fetch(`${baseUrl}/v1/memory${path}`, { method, headers: { Authorization: `Bearer ${key}` } });
    type Listing = { bank: { bankId: string; files: number }; files: Array<{ id: string; path: string; size: number }>; total: number };
    const list = async (key: string, query = ''): Promise<Listing> => {
      const res = await web(key, 'GET', `/banks/${bankRowId}/files${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as Listing;
    };

    beforeAll(async () => {
      vera = await person('vera', WS_A, 'viewer');
      admin = await person('admin', WS_A, 'admin');
      await rest(people.alice.key, bank, { command: 'create', path: '/memories/notes/deploy.md', file_text: '# Deploy\nrun the canary first — straße' });
      await rest(people.alice.key, bank, { command: 'create', path: '/memories/a.md', file_text: 'token for ci: alice@example.com' });
      bankRowId = (await bankRow(WS_A, bank))!.id;
    }, 30_000);

    it('lists a viewer the files by path with their size in bytes, and serves one file’s text as stored', async () => {
      const all = await list(vera.key);
      expect(all.bank).toMatchObject({ bankId: bank, files: 2 });
      expect(all.files.map((f) => f.path)).toEqual(['/memories/a.md', '/memories/notes/deploy.md']);
      expect(all.files[1]!.size).toBe(Buffer.byteLength('# Deploy\nrun the canary first — straße'));
      expect((await list(vera.key, '?q=NOTES')).files.map((f) => f.path)).toEqual(['/memories/notes/deploy.md']);
      const one = await web(vera.key, 'GET', `/banks/${bankRowId}/files/${all.files[0]!.id}`);
      expect(one.status).toBe(200);
      const file = (await one.json()) as { path: string; content: string; size: number };
      // Masked on write: the stored text is what is served.
      expect(file).toMatchObject({ path: '/memories/a.md', content: 'token for ci: [SECRET_1]', size: all.files[0]!.size });
      expect(file.content).not.toContain('alice@example.com');
      expect(Buffer.byteLength(file.content)).toBe(file.size);
      expect((await web(people.carol.key, 'GET', `/banks/${bankRowId}/files`)).status).toBe(403);
      expect((await web(vera.key, 'GET', `/banks/${bankRowId}/files/${randomUUID()}`)).status).toBe(404);
    });

    it('refuses a viewer’s delete', async () => {
      const [file] = (await list(vera.key)).files;
      expect((await web(vera.key, 'DELETE', `/banks/${bankRowId}/files/${file!.id}`)).status).toBe(403);
      expect((await list(vera.key)).total).toBe(2);
    });

    it('hides a bank bound to a project the member cannot see', async () => {
      const project = await prisma.project.create({ data: { workspaceId: WS_A, name: `Files page ${nonce}` } });
      const set = await fetch(`${baseUrl}/v1/projects/${project.id}/access`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${admin.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.alice.id, level: 'view' }] }),
      });
      expect(set.status).toBe(200);
      await prisma.memoryBank.update({ where: { id: bankRowId }, data: { projectId: project.id } });
      try {
        expect((await web(vera.key, 'GET', `/banks/${bankRowId}/files`)).status).toBe(404);
        expect((await list(people.alice.key)).total).toBe(2);
      } finally {
        await prisma.memoryBank.update({ where: { id: bankRowId }, data: { projectId: null } });
      }
    });

    it('lets an editor delete a file with its recall chunks, as the tool’s own delete does', async () => {
      const deploy = (await list(people.alice.key)).files.find((f) => f.path === '/memories/notes/deploy.md')!;
      const chunks = await prisma.memoryUnit.findMany({ where: { bankId: bankRowId, documentId: 'file:/memories/notes/deploy.md' }, select: { id: true } });
      expect(chunks.length).toBeGreaterThan(0);
      expect((await web(people.alice.key, 'DELETE', `/banks/${bankRowId}/files/${deploy.id}`)).status).toBe(204);
      expect((await web(people.alice.key, 'DELETE', `/banks/${bankRowId}/files/${deploy.id}`)).status).toBe(404);
      expect(await prisma.memoryUnit.count({ where: { id: { in: chunks.map((c) => c.id) } } })).toBe(0);
      const vectors = (await graph.memoryUnitIds(WS_A)).map((v) => v.unitId);
      for (const c of chunks) expect(vectors).not.toContain(c.id);
      expect(await rest(people.alice.key, bank, { command: 'view', path: '/memories/notes' })).toEqual({ content: 'Error: The path /memories/notes does not exist. Please provide a valid path.', is_error: true });
      expect((await list(people.alice.key)).files.map((f) => f.path)).toEqual(['/memories/a.md']);
    }, 30_000);
  });

  it('answers 404 with the section off or MEMORY_ENABLED off, writing nothing', async () => {
    const create = { command: 'create', path: '/memories/x.md', file_text: 'x' };
    const mcpCall = (key: string, path: string) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory', arguments: create } }),
      });
    expect((await post(people.erin.key, `off-${nonce}`, create)).status).toBe(404);
    expect((await mcpCall(people.erin.key, `/mcp/off-${nonce}/files`)).status).toBe(404);
    expect(await prisma.memoryFile.count({ where: { workspaceId: WS_OFF } })).toBe(0);

    const { FeaturesService: Features } = await import('../src/auth/features.service.js');
    const unavailable = vi.spyOn(app.get<FeaturesService>(Features), 'unavailable').mockReturnValue(['memory']);
    try {
      expect((await post(people.alice.key, `off-${nonce}`, create)).status).toBe(404);
      expect((await mcpCall(people.alice.key, `/mcp/off-${nonce}/files`)).status).toBe(404);
    } finally {
      unavailable.mockRestore();
    }
    expect(await prisma.memoryBank.count({ where: { bankId: `off-${nonce}` } })).toBe(0);
  });

  describe('the recall index stays level with the files (#1009 gaps)', () => {
    const bank = `level-${nonce}`;
    const call = (input: Input) => rest(people.alice.key, bank, input);
    const fileRow = (path: string) => prisma.memoryFile.findFirstOrThrow({ where: { workspaceId: WS_A, bank: { bankId: bank }, path } });
    const chunks = (path: string) => prisma.memoryUnit.findMany({ where: { workspaceId: WS_A, documentId: `file:${path}` }, orderBy: { text: 'asc' } });
    const stale = async (path: string) => {
      const f = await fileRow(path);
      return f.indexedAt?.getTime() !== f.updatedAt.getTime();
    };
    /** Sweeps past the grace until `path` is level; other files a dev DB holds may come first. */
    async function sweepUntilLevel(path: string): Promise<void> {
      const { MemoryFilesIndexSweeper } = await import('../src/memory/memory-files-index.sweeper.js');
      const sweeper = app.get(MemoryFilesIndexSweeper);
      for (let i = 0; i < 50 && (await stale(path)); i++) await sweeper.sweep(Date.now() + 60_000);
      expect(await stale(path)).toBe(false);
    }

    it('marks a written file indexed; a missed index is rewritten by the sweeper; a rename is re-embedded', async () => {
      await call({ command: 'create', path: '/memories/runbook.md', file_text: 'Paging goes to the on-call SRE.' });
      expect(await stale('/memories/runbook.md')).toBe(false);

      // An index that failed after the write: no chunk, the row stale.
      const before = await chunks('/memories/runbook.md');
      await prisma.memoryUnit.deleteMany({ where: { id: { in: before.map((c) => c.id) } } });
      await prisma.$executeRaw`UPDATE memory_files SET indexed_at = NULL WHERE workspace_id = ${WS_A}::uuid AND path = '/memories/runbook.md'`;
      await sweepUntilLevel('/memories/runbook.md');
      expect((await chunks('/memories/runbook.md')).map((c) => c.text)).toEqual(['Paging goes to the on-call SRE.']);

      // A rename moves the chunks at once and leaves the file stale; the sweep re-embeds them under the new path.
      const moved = (await chunks('/memories/runbook.md')).map((c) => c.id);
      await call({ command: 'rename', old_path: '/memories/runbook.md', new_path: '/memories/ops/runbook.md' });
      expect((await chunks('/memories/ops/runbook.md')).map((c) => c.id)).toEqual(moved);
      expect(await stale('/memories/ops/runbook.md')).toBe(true);
      await sweepUntilLevel('/memories/ops/runbook.md');
      const fresh = await chunks('/memories/ops/runbook.md');
      expect(fresh.map((c) => [c.text, c.context])).toEqual([['Paging goes to the on-call SRE.', '/memories/ops/runbook.md']]);
      expect(fresh.map((c) => c.id)).not.toEqual(moved);
      expect(await chunks('/memories/runbook.md')).toEqual([]);
    }, 60_000);

    it('an index that read the text before a later write writes nothing of it, and settles on the text as stored', async () => {
      await call({ command: 'create', path: '/memories/owner.md', file_text: 'Billing is owned by Gwen.' });
      await call({ command: 'str_replace', path: '/memories/owner.md', old_str: 'Gwen', new_str: 'Hugo' });
      const row = await fileRow('/memories/owner.md');
      await prisma.$executeRaw`UPDATE memory_files SET indexed_at = NULL WHERE id = ${row.id}::uuid`;
      // The index's first read sees the text before the str_replace, as a slow writer racing the next one would.
      const { MemoryFilesService } = await import('../src/memory/memory-files.service.js');
      const files = app.get(MemoryFilesService);
      const read = vi.spyOn(prisma.memoryFile, 'findFirst').mockResolvedValueOnce({ ...row, content: 'Billing is owned by Gwen.' } as never);
      try {
        expect(await files.reindex((await bankRow(WS_A, bank))!, row.id)).toBe(true);
      } finally {
        read.mockRestore();
      }
      expect((await chunks('/memories/owner.md')).map((c) => c.text)).toEqual(['Billing is owned by Hugo.']);
      expect(await stale('/memories/owner.md')).toBe(false);

      // A file deleted before its index runs gets no chunk back.
      await call({ command: 'delete', path: '/memories/owner.md' });
      expect(await files.reindex((await bankRow(WS_A, bank))!, row.id)).toBe(true);
      expect(await chunks('/memories/owner.md')).toEqual([]);
    }, 60_000);

    it('a Hindsight clear keeps the files’ chunks: recall still finds what view shows', async () => {
      await call({ command: 'create', path: '/memories/pager.md', file_text: 'The pager rotation changes on Mondays.' });
      await hindsight(people.alice.key).retain(bank, 'Gwen prefers async standups.');
      const cleared = await fetch(`${baseUrl}/v1/default/banks/${bank}/memories`, { method: 'DELETE', headers: { Authorization: `Bearer ${people.alice.key}` } });
      expect(cleared.status).toBe(200);
      const row = (await bankRow(WS_A, bank))!;
      expect(await prisma.memoryUnit.count({ where: { bankId: row.id, NOT: { documentId: { startsWith: 'file:' } } } })).toBe(0);
      expect((await chunks('/memories/pager.md')).map((c) => c.text)).toEqual(['The pager rotation changes on Mondays.']);
      expect((await hindsight(people.alice.key).recall(bank, 'When does the pager rotation change?')).results.map((r) => r.text)).toContainEqual(expect.stringContaining('Mondays'));
    }, 60_000);
  });
});
