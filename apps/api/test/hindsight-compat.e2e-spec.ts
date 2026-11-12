import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HindsightClient, sdk } from '@vectorize-io/hindsight-client';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { FeaturesService } from '../src/auth/features.service.js';
import type { GraphService } from '../src/graph/graph.service.js';

/**
 * #986 acceptance, end to end against live infra: the official Hindsight
 * TypeScript client, pointed at this API with a workspace-pinned key, and
 * nothing on its side changed. It grows with each phase of the milestone.
 *
 * Like page-permissions.e2e-spec.ts it forces `AUTH_MODE=api-key` and makes
 * its own people, none of them a platform admin:
 *
 *   admin — workspace admin of A (restricts the project)
 *   alice — editor of A, with a grant on the restricted project
 *   bob   — editor of A, with none
 *   carol — editor of B, a second workspace with memory on
 *   erin  — editor of OFF, a workspace with the `memory` section switched off
 *
 * Embeddings are the stub provider and no extraction model is routed, so no
 * model is called: what is asserted is the wire, the store and the boundary.
 *
 * Needs `make infra-up`. Not part of `make verify`:
 * `pnpm --filter @knowledge/api run test:e2e hindsight-compat`.
 */

const WS_A = '98600000-0000-4986-8986-00000000000a';
const WS_B = '98600000-0000-4986-8986-00000000000b';
const WS_OFF = '98600000-0000-4986-8986-00000000000c';
const WORKSPACES = [WS_A, WS_B, WS_OFF];

type Person = { id: string; key: string };

describe('Hindsight compatibility (e2e, #986)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let graph: GraphService;
  let baseUrl: string;
  const nonce = randomUUID().slice(0, 8);
  const bank = `agent-${nonce}`;
  const keyIds: string[] = [];
  const people = {} as Record<'admin' | 'alice' | 'bob' | 'carol' | 'erin', Person>;

  const client = (key: string) => new HindsightClient({ baseUrl, apiKey: key, maxAttempts: 1 });
  /** The generated SDK, for the routes the wrapper class has no method for. */
  const raw = (key: string) => (client(key) as unknown as { client: NonNullable<Parameters<typeof sdk.listBanks>[0]>['client'] }).client;
  const call = (key: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function mintKey(userId: string, data: { workspaceId: string | null; scope?: string; toolsets?: string[] }): Promise<string> {
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: {
        userId,
        name: `hindsight e2e ${nonce}`,
        keyHash: createHash('sha256').update(key).digest('hex'),
        prefix: key.slice(0, 11),
        scope: data.scope ?? 'write',
        workspaceId: data.workspaceId,
        ...(data.toolsets ? { toolsets: data.toolsets } : {}),
      },
    });
    keyIds.push(row.id);
    return key;
  }

  async function person(name: string, workspaceId: string, role: 'admin' | 'editor'): Promise<Person> {
    const email = `hindsight-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Hindsight ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: { role },
      create: { workspaceId, userId: user.id, role },
    });
    return { id: user.id, key: await mintKey(user.id, { workspaceId }) };
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    process.env.MEMORY_ENABLED = 'true';
    process.env.EMBEDDINGS_PROVIDER = 'stub';
    const [{ createE2eApp }, { PrismaService }, { GraphService }, { EMBEDDING_PROVIDER }, { MemoryWorkerModule }] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/prisma/prisma.service.js'),
      import('../src/graph/graph.service.js'),
      import('../src/embedding/embedding.provider.js'),
      import('../src/memory/memory-worker.module.js'),
    ]);
    app = await createE2eApp([MemoryWorkerModule]);
    prisma = app.get(PrismaService);
    graph = app.get(GraphService);
    // What the worker does on boot: the MemoryUnit vector type and its index.
    await graph.ensureSchema(app.get<{ dimension: number }>(EMBEDDING_PROVIDER).dimension);
    // The official client speaks fetch, so it needs a real port.
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    for (const [i, id] of WORKSPACES.entries()) {
      await prisma.workspace.upsert({ where: { id }, update: { deletedAt: null }, create: { id, name: `Hindsight e2e ${'AB-'[i]} (#986)` } });
    }
    await prisma.memoryBank.deleteMany({ where: { workspaceId: { in: WORKSPACES } } });
    await prisma.workspaceSettings.upsert({
      where: { workspaceId: WS_OFF },
      update: { disabledFeatures: ['memory'] },
      create: { workspaceId: WS_OFF, disabledFeatures: ['memory'] },
    });
    people.admin = await person('admin', WS_A, 'admin');
    people.alice = await person('alice', WS_A, 'editor');
    people.bob = await person('bob', WS_A, 'editor');
    people.carol = await person('carol', WS_B, 'editor');
    people.erin = await person('erin', WS_OFF, 'editor');
  });

  afterAll(async () => {
    if (!app) return;
    await prisma.memoryBank.deleteMany({ where: { workspaceId: { in: WORKSPACES } } });
    for (const ws of WORKSPACES) await graph.deleteMemoryUnits(ws, (await graph.memoryUnitIds(ws)).map((v) => v.unitId));
    await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  describe('phase 0: banks', () => {
    it('answers the probes a client sends first', async () => {
      const version = await client(people.alice.key).getVersion();
      expect(version.api_version).toBe('1.2.1');
      expect(version.features).toMatchObject({ file_upload_api: false, bank_config_api: false });
      expect((await sdk.healthEndpointHealthGet({ client: raw(people.alice.key) })).data).toMatchObject({ status: 'healthy' });
    });

    it('creates a bank, lists it, reads and updates its profile', async () => {
      const hs = client(people.alice.key);
      const created = await hs.createBank(bank, { name: 'Agent memory', reflectMission: 'Remember what the team decides.' });
      expect(created).toEqual({
        bank_id: bank,
        name: 'Agent memory',
        mission: 'Remember what the team decides.',
        disposition: { skepticism: 3, literalism: 3, empathy: 3 },
        background: null,
      });

      const listed = await sdk.listBanks({ client: raw(people.alice.key) });
      expect(listed.data?.banks.map((b) => b.bank_id)).toContain(bank);
      expect(listed.data?.total).toBeGreaterThanOrEqual(1);

      expect(await hs.getBankProfile(bank)).toEqual(created);

      // PUT again updates, leaving what the body does not name.
      expect(await hs.createBank(bank, { dispositionSkepticism: 5 })).toMatchObject({ name: 'Agent memory', disposition: { skepticism: 5, literalism: 3, empathy: 3 } });
      const disposition = { skepticism: 1, literalism: 2, empathy: 4 };
      const updated = await sdk.updateBankDisposition({ client: raw(people.alice.key), path: { bank_id: bank }, body: { disposition } });
      expect(updated.data).toMatchObject({ bank_id: bank, disposition });
      const patched = await sdk.updateBank({ client: raw(people.alice.key), path: { bank_id: bank }, body: { mission: 'Changed.' } });
      expect(patched.data).toMatchObject({ mission: 'Changed.', disposition });
    });

    it('answers errors in the shape the client reads', async () => {
      await expect(client(people.alice.key).getBankProfile(`missing-${nonce}`)).rejects.toMatchObject({ statusCode: 404, details: expect.stringContaining('not found') });
      // An unmatched route under the prefix and a failed validation leave in the same shape.
      const unmatched = await call(people.alice.key, 'GET', `/v1/default/banks/${bank}/mental-models`);
      expect(unmatched.status).toBe(404);
      expect(await unmatched.json()).toEqual({ detail: expect.any(String) });
      const invalid = await call(people.alice.key, 'PUT', `/v1/default/banks/${bank}/profile`, { disposition: { skepticism: 9, literalism: 1, empathy: 1 } });
      expect(invalid.status).toBe(422);
      expect((await invalid.json()).detail[0]).toMatchObject({ loc: ['body'], msg: expect.any(String) });
      const patchMissing = await call(people.alice.key, 'PATCH', `/v1/default/banks/missing-${nonce}`, { name: 'x' });
      expect(patchMissing.status).toBe(404);
    });

    it('refuses a key with no workspace pin, a key limited to toolsets, and a read-only key that writes', async () => {
      const unpinned = await call(await mintKey(people.alice.id, { workspaceId: null }), 'GET', '/v1/default/banks');
      expect(unpinned.status).toBe(400);
      expect((await unpinned.json()).detail).toMatch(/pinned to one workspace/);

      const toolsets = await call(await mintKey(people.alice.id, { workspaceId: WS_A, toolsets: ['search'] }), 'GET', '/v1/default/banks');
      expect(toolsets.status).toBe(403);

      const readOnly = await mintKey(people.alice.id, { workspaceId: WS_A, scope: 'read' });
      expect((await call(readOnly, 'GET', `/v1/default/banks/${bank}/profile`)).status).toBe(200);
      expect((await call(readOnly, 'PUT', `/v1/default/banks/ro-${nonce}`, {})).status).toBe(403);
      expect((await call(readOnly, 'DELETE', `/v1/default/banks/${bank}`)).status).toBe(403);
      expect(await prisma.memoryBank.count({ where: { workspaceId: WS_A, bankId: `ro-${nonce}` } })).toBe(0);
    });

    it('keeps a bank inside its workspace', async () => {
      const listed = await sdk.listBanks({ client: raw(people.carol.key) });
      expect(listed.data?.banks).toEqual([]);
      await expect(client(people.carol.key).getBankProfile(bank)).rejects.toMatchObject({ statusCode: 404 });
      expect((await call(people.carol.key, 'DELETE', `/v1/default/banks/${bank}`)).status).toBe(404);
      expect((await call(people.carol.key, 'PATCH', `/v1/default/banks/${bank}`, { name: 'taken' })).status).toBe(404);
      expect(await prisma.memoryBank.count({ where: { workspaceId: WS_A, bankId: bank, name: 'Agent memory' } })).toBe(1);
    });

    it('hides a bank bound to a restricted project from a member who cannot see the project', async () => {
      const project = await prisma.project.create({ data: { workspaceId: WS_A, name: `Secret ${nonce}` } });
      const set = await call(people.admin.key, 'PUT', `/v1/projects/${project.id}/access`, {
        restricted: true,
        grants: [{ subjectType: 'user', subjectId: people.alice.id, level: 'view' }],
      });
      expect(set.status).toBe(200);
      const secret = `secret-${nonce}`;
      await client(people.alice.key).createBank(secret);
      await prisma.memoryBank.update({ where: { workspaceId_bankId: { workspaceId: WS_A, bankId: secret } }, data: { projectId: project.id } });

      expect((await client(people.alice.key).getBankProfile(secret)).bank_id).toBe(secret);
      await expect(client(people.bob.key).getBankProfile(secret)).rejects.toMatchObject({ statusCode: 404 });
      expect((await call(people.bob.key, 'PUT', `/v1/default/banks/${secret}`, { name: 'mine now' })).status).toBe(404);
      const bobs = await sdk.listBanks({ client: raw(people.bob.key) });
      expect(bobs.data?.banks.map((b) => b.bank_id)).toEqual([bank]);
      const admins = await sdk.listBanks({ client: raw(people.admin.key) });
      expect(admins.data?.banks.map((b) => b.bank_id).sort()).toEqual([bank, secret].sort());
    });

    it('answers 404 everywhere with the section off in the workspace, or MEMORY_ENABLED off on the server', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/v1/default/banks'],
        ['PUT', `/v1/default/banks/off-${nonce}`, {}],
        ['PATCH', `/v1/default/banks/off-${nonce}`, {}],
        ['DELETE', `/v1/default/banks/off-${nonce}`],
        ['GET', `/v1/default/banks/off-${nonce}/profile`],
        ['PUT', `/v1/default/banks/off-${nonce}/profile`, { disposition: { skepticism: 1, literalism: 1, empathy: 1 } }],
      ];
      for (const [method, path, body] of routes) expect([method, path, (await call(people.erin.key, method, path, body)).status]).toEqual([method, path, 404]);
      expect(await prisma.memoryBank.count({ where: { workspaceId: WS_OFF } })).toBe(0);

      const { FeaturesService: Features } = await import('../src/auth/features.service.js');
      const features: FeaturesService = app.get(Features);
      const unavailable = vi.spyOn(features, 'unavailable').mockReturnValue(['memory']);
      try {
        for (const [method, path, body] of [...routes, ['GET', '/version'], ['GET', '/health']] as typeof routes) {
          expect([method, path, (await call(people.alice.key, method, path, body)).status]).toEqual([method, path, 404]);
        }
      } finally {
        unavailable.mockRestore();
      }
    });

    it('deletes a bank', async () => {
      await client(people.alice.key).deleteBank(bank);
      await expect(client(people.alice.key).getBankProfile(bank)).rejects.toMatchObject({ statusCode: 404 });
      const audit = await prisma.auditLog.findMany({ where: { workspaceId: WS_A, target: bank }, select: { action: true } });
      expect(audit.map((a) => a.action).sort()).toEqual(['memory.bank_created', 'memory.bank_deleted']);
    });
  });

  describe('phase 1: sync retain', () => {
    const mem = `mem-${nonce}`;
    const word = `zorblat${nonce}`;
    const secret = `sk-${'a1B2c3D4'.repeat(4)}`;
    const units = (bankId = mem) => prisma.memoryUnit.findMany({ where: { workspaceId: WS_A, bank: { bankId } }, orderBy: { createdAt: 'asc' }, include: { entities: true } });

    it('retains one item, creating the bank, and stores it verbatim with no extraction model', async () => {
      const hs = client(people.alice.key);
      const res = await hs.retain(mem, `The ${word} deploy runs on Tuesdays.`, {
        context: 'ops standup',
        tags: ['ops', 'deploy', 'ops'],
        metadata: { source: 'e2e' },
        documentId: 'standup-1',
        timestamp: '2026-11-10T09:00:00Z',
        entities: [{ text: 'Billing Service', type: 'service' }],
      });
      expect(res).toEqual({ success: true, bank_id: mem, items_count: 1, async: false });
      expect((await hs.getBankProfile(mem)).name).toBe(mem);

      const [unit] = await units();
      expect(unit).toMatchObject({
        text: `The ${word} deploy runs on Tuesdays.`,
        factType: 'world',
        context: 'ops standup',
        tags: ['deploy', 'ops'],
        metadata: { source: 'e2e' },
        documentId: 'standup-1',
        createdBy: people.alice.id,
      });
      expect(unit!.occurredStart?.toISOString()).toBe('2026-11-10T09:00:00.000Z');
      expect(unit!.entities.map((e) => e.entityKey)).toEqual(['service:billing-service']);
    });

    it('retains a batch of three, and memories/list returns the stored units', async () => {
      const hs = client(people.alice.key);
      const res = await hs.retainBatch(mem, [
        { content: `Alice owns the ${word} runbook.`, tags: ['ops'] },
        { content: `The ${word} staging key is ${secret}, mail ops@example.com.`, document_id: 'keys' },
        { content: `Rollbacks of ${word} need two approvals.`, timestamp: 'unset' as unknown as Date },
      ]);
      expect(res).toMatchObject({ success: true, items_count: 3, async: false });

      const listed = await hs.listMemories(mem);
      expect(listed.total).toBe(4);
      expect(listed.items.map((i) => i.text)).toEqual(expect.arrayContaining([`Alice owns the ${word} runbook.`, `Rollbacks of ${word} need two approvals.`]));
      expect(listed.items[0]).toMatchObject({ id: expect.any(String), fact_type: 'world', state: 'valid' });

      expect((await hs.listMemories(mem, { tags: ['ops'], tagsMatch: 'any_strict' })).total).toBe(2);
      expect((await hs.listMemories(mem, { tags: ['ops'] })).total).toBe(4);
      expect((await hs.listMemories(mem, { tags: ['deploy', 'ops'], tagsMatch: 'exact' })).total).toBe(1);
      expect((await hs.listMemories(mem, { q: 'rollbacks', limit: 1 })).items).toHaveLength(1);
      expect((await hs.listMemories(mem, { documentId: 'keys' })).total).toBe(1);
    });

    it('masks a secret and an address before anything is stored', async () => {
      const stored = await units();
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(JSON.stringify(stored)).not.toContain('ops@example.com');
      expect(stored.find((u) => u.documentId === 'keys')!.text).toBe(`The ${word} staging key is [SECRET_1], mail [EMAIL_1].`);
    });

    it('replaces a document_id retained before, and appends when asked', async () => {
      const hs = client(people.alice.key);
      const before = (await units()).find((u) => u.documentId === 'standup-1')!;
      await hs.retain(mem, `The ${word} deploy moved to Wednesdays.`, { documentId: 'standup-1' });
      const after = (await units()).filter((u) => u.documentId === 'standup-1');
      expect(after.map((u) => u.text)).toEqual([`The ${word} deploy moved to Wednesdays.`]);
      // The replaced unit's vector went with its row.
      expect((await graph.memoryUnitIds(WS_A)).map((v) => v.unitId)).not.toContain(before.id);

      await hs.retain(mem, `And ${word} hotfixes any day.`, { documentId: 'standup-1', updateMode: 'append' });
      expect((await units()).filter((u) => u.documentId === 'standup-1')).toHaveLength(2);
    });

    it('folds two spellings of an entity to one key', async () => {
      const hs = client(people.alice.key);
      await hs.retain(mem, `${word} bills through it.`, { documentId: 'entities', entities: [{ text: 'Billing  SERVICE', type: 'Service' }, { text: 'billing service', type: 'service' }] });
      const keys = (await units()).flatMap((u) => u.entities.map((e) => e.entityKey));
      expect([...new Set(keys)]).toEqual(['service:billing-service']);
      // Rows only: memory writes nothing into the workspace relation graph.
      const page = await call(people.alice.key, 'POST', '/v1/search', { workspaceId: WS_A, query: `${word} deploy`, limit: 10 });
      expect(page.status).toBe(200);
      expect((await page.json()).results).toEqual([]);
    });

    it('lets a capture key and a write key retain, never a read key', async () => {
      const capture = await mintKey(people.alice.id, { workspaceId: WS_A, scope: 'capture' });
      expect((await client(capture).retain(mem, `${word} captured.`, { documentId: 'capture' })).success).toBe(true);
      // A capture key retains and nothing more: it cannot clear the bank.
      expect((await call(capture, 'DELETE', `/v1/default/banks/${mem}/memories`)).status).toBe(403);
      const readOnly = await mintKey(people.alice.id, { workspaceId: WS_A, scope: 'read' });
      await expect(client(readOnly).retain(mem, 'nope')).rejects.toMatchObject({ statusCode: 403 });
      expect((await client(readOnly).listMemories(mem)).total).toBeGreaterThan(0);
    });

    it('refuses what is not text, too many items, and a bad timestamp, as a 400', async () => {
      const post = (body: unknown) => call(people.alice.key, 'POST', `/v1/default/banks/${mem}/memories`, body);
      const blocks = await post({ items: [{ content: [{ type: 'text', text: 'hi' }] }] });
      expect(blocks.status).toBe(400);
      expect((await blocks.json()).detail).toMatch(/must be a string/);
      expect((await post({ items: [] })).status).toBe(400);
      expect((await post({ items: [{ content: 'x', timestamp: 'yesterday' }] })).status).toBe(400);
      expect((await post({ items: 'x' })).status).toBe(422);
    });

    it('reads one memory and the bank stats, and keeps both inside the workspace', async () => {
      const [first] = await units();
      const got = await sdk.getMemory({ client: raw(people.alice.key), path: { bank_id: mem, memory_id: first!.id } });
      expect(got.data).toMatchObject({ id: first!.id, text: first!.text, type: 'world' });
      const stats = await sdk.getAgentStats({ client: raw(people.alice.key), path: { bank_id: mem } });
      const total = (await units()).length;
      expect(stats.data).toMatchObject({ bank_id: mem, total_nodes: total, nodes_by_fact_type: { world: total }, pending_operations: 0 });
      const listed = await sdk.listBanks({ client: raw(people.alice.key) });
      expect(listed.data?.banks.find((b) => b.bank_id === mem)?.fact_count).toBe(total);

      for (const path of [`/memories/list`, `/memories/${first!.id}`, `/stats`]) {
        expect([path, (await call(people.carol.key, 'GET', `/v1/default/banks/${mem}${path}`)).status]).toEqual([path, 404]);
      }
      expect((await call(people.carol.key, 'DELETE', `/v1/default/banks/${mem}/memories`)).status).toBe(404);
      expect((await units()).length).toBe(total);
    });

    it('deletes memories at once, their vectors with them, and reaps a vector with no row', async () => {
      const { MemoryReapSweeper } = await import('../src/memory/memory-reap.sweeper.js');
      const { EMBEDDING_PROVIDER } = await import('../src/embedding/embedding.provider.js');
      const orphan = randomUUID();
      const embedding = await app.get<{ embed(t: string): Promise<number[]> }>(EMBEDDING_PROVIDER).embed('orphan');
      await graph.upsertMemoryUnits(WS_A, randomUUID(), [{ unitId: orphan, embedding }], Date.now() - 60 * 60_000);
      const fresh = randomUUID();
      await graph.upsertMemoryUnits(WS_A, randomUUID(), [{ unitId: fresh, embedding }], Date.now());

      const total = (await units()).length;
      const cleared = await sdk.clearBankMemories({ client: raw(people.alice.key), path: { bank_id: mem } });
      expect(cleared.data).toMatchObject({ success: true, deleted_count: total });
      expect(await units()).toEqual([]);
      expect((await graph.memoryUnitIds(WS_A)).map((v) => v.unitId).sort()).toEqual([orphan, fresh].sort());

      expect(await app.get(MemoryReapSweeper).sweep()).toBeGreaterThanOrEqual(1);
      // Old enough to be an orphan: gone. Written a moment ago: left for the retain that may still commit its row.
      expect((await graph.memoryUnitIds(WS_A)).map((v) => v.unitId)).toEqual([fresh]);
    });

    it('removes a deleted workspace’s banks, memories and vectors', async () => {
      const { WorkspaceTeardownService } = await import('../src/workspaces/workspace-teardown.service.js');
      const doomed = randomUUID();
      await prisma.workspace.create({ data: { id: doomed, name: `Hindsight doomed ${nonce}` } });
      const dana = await person(`dana-${nonce}`, doomed, 'editor');
      await client(dana.key).retain(`gone-${nonce}`, `${word} will not survive.`, { entities: [{ text: 'Ghost' }] });
      expect((await graph.memoryUnitIds(doomed)).length).toBe(1);

      await prisma.workspace.update({ where: { id: doomed }, data: { deletedAt: new Date() } });
      for (let i = 0; i < 20 && !(await app.get(WorkspaceTeardownService).teardown(doomed)); i++);
      expect(await prisma.memoryBank.count({ where: { workspaceId: doomed } })).toBe(0);
      expect(await prisma.memoryUnit.count({ where: { workspaceId: doomed } })).toBe(0);
      expect(await prisma.memoryUnitEntity.count({ where: { workspaceId: doomed } })).toBe(0);
      expect(await graph.memoryUnitIds(doomed)).toEqual([]);
      await prisma.user.delete({ where: { id: dana.id } });
    });
  });

  describe('phase 2: recall', () => {
    const mem = `recall-${nonce}`;
    const texts = (r: { results: Array<{ text: string }> }) => r.results.map((x) => x.text);
    // The stub embedder ranks by shared words, never meaning, and always returns its nearest: a floor no
    // stub vector reaches takes the semantic leg out, so a test can see what another leg adds on its own.
    const noSemantic = { minScores: { semantic: 0.999 } };

    beforeAll(async () => {
      const hs = client(people.alice.key);
      await hs.retainBatch(mem, [
        { content: 'Alice works at Google as a software engineer', document_id: 'alice', entities: [{ text: 'Google', type: 'org' }], timestamp: '2026-06-15T10:00:00Z' },
        { content: 'The campus has a climbing gym', document_id: 'gym', entities: [{ text: 'google', type: 'ORG' }], timestamp: '2026-06-16T10:00:00Z' },
        { content: 'Bob prefers tea over coffee', document_id: 'bob', tags: ['user:a'], timestamp: '2026-01-10T10:00:00Z' },
        { content: 'Carol prefers coffee over tea', document_id: 'carol', tags: ['user:b'], timestamp: '2026-06-20T10:00:00Z' },
        { content: 'The office closes at six', document_id: 'office', timestamp: '2026-06-21T10:00:00Z' },
      ]);
    });

    it('recalls what was retained, in Hindsight’s shape', async () => {
      const res = await client(people.alice.key).recall(mem, 'What does Alice do?');
      expect(res.results[0]).toMatchObject({
        id: expect.any(String),
        text: 'Alice works at Google as a software engineer',
        type: 'world',
        entities: ['Google'],
        document_id: 'alice',
        occurred_start: '2026-06-15T10:00:00.000Z',
        tags: [],
        scores: { final: expect.any(Number), keyword: expect.any(Number) },
      });
      expect(res.entities).toMatchObject({ Google: { entity_id: 'org:google', canonical_name: 'Google', observations: [] } });
      const bare = await client(people.alice.key).recall(mem, 'What does Alice do?', { includeEntities: false, includeChunks: true });
      expect(bare.entities).toBeUndefined();
      expect(bare.chunks).toEqual({});
    });

    it('filters by tags the way Hindsight does, untagged memories included or not', async () => {
      const hs = client(people.alice.key);
      const strict = texts(await hs.recall(mem, 'who prefers tea or coffee', { tags: ['user:b'], tagsMatch: 'any_strict' }));
      expect(strict).toEqual(['Carol prefers coffee over tea']);
      const any = texts(await hs.recall(mem, 'who prefers tea or coffee', { tags: ['user:b'], tagsMatch: 'any' }));
      expect(any).toContain('Carol prefers coffee over tea');
      expect(any).toContain('The office closes at six');
      expect(any).not.toContain('Bob prefers tea over coffee');
      expect(texts(await hs.recall(mem, 'who prefers tea or coffee', { tags: ['user:a', 'user:b'], tagsMatch: 'all_strict' }))).toEqual([]);
      expect(texts(await hs.recall(mem, 'tea', { types: ['observation'] }))).toEqual([]);
      expect(texts(await hs.recall(mem, 'tea', { types: ['world'], ...noSemantic })).sort()).toEqual(['Bob prefers tea over coffee', 'Carol prefers coffee over tea']);
    });

    it('adds memories inside a time window, and none outside it', async () => {
      const hs = client(people.alice.key);
      const none = await hs.recall(mem, 'zzzunmatched', noSemantic);
      expect(none.results).toEqual([]);
      const january = await hs.recall(mem, 'zzzunmatched', { ...noSemantic, temporalWindow: { start: '2026-01-01T00:00:00Z', end: '2026-01-31T23:59:59Z' } });
      expect(texts(january)).toEqual(['Bob prefers tea over coffee']);
      // Surfaced by the temporal leg alone: neither retrieval leg scored it.
      expect(january.results[0]!.scores).toEqual({ final: expect.any(Number) });
    });

    it('adds memories that share an entity with the best hits', async () => {
      const res = await client(people.alice.key).recall(mem, 'Alice', noSemantic);
      expect(texts(res)).toEqual(['Alice works at Google as a software engineer', 'The campus has a climbing gym']);
      expect(res.results[1]!.scores?.keyword).toBeUndefined();
    });

    it('cuts the results to max_tokens, best first', async () => {
      const hs = client(people.alice.key);
      const all = await hs.recall(mem, 'Alice Bob Carol office campus');
      const cut = await hs.recall(mem, 'Alice Bob Carol office campus', { maxTokens: 20 });
      expect(all.results.length).toBe(5);
      expect(cut.results.length).toBeGreaterThan(0);
      expect(cut.results.length).toBeLessThan(all.results.length);
      expect(texts(cut)).toEqual(texts(all).slice(0, cut.results.length));
    });

    it('never serves a vector whose row is gone', async () => {
      const row = await prisma.memoryUnit.findFirstOrThrow({ where: { workspaceId: WS_A, documentId: 'office', bank: { bankId: mem } } });
      await prisma.memoryUnit.delete({ where: { id: row.id } });
      expect((await graph.memoryUnitIds(WS_A)).map((v) => v.unitId)).toContain(row.id);
      expect(texts(await client(people.alice.key).recall(mem, 'when does the office close'))).not.toContain('The office closes at six');
    });

    it('refuses a bank that is not the caller’s before anything is embedded', async () => {
      const { EMBEDDING_PROVIDER } = await import('../src/embedding/embedding.provider.js');
      const embed = vi.spyOn(app.get<{ embed(t: string): Promise<number[]> }>(EMBEDDING_PROVIDER), 'embed');
      try {
        await expect(client(people.carol.key).recall(mem, 'What does Alice do?')).rejects.toMatchObject({ statusCode: 404 });
        await expect(client(people.alice.key).recall(`missing-${nonce}`, 'anything')).rejects.toMatchObject({ statusCode: 404 });
        expect(embed).not.toHaveBeenCalled();
        // A read-only key recalls: it is a viewer's call.
        const readOnly = await mintKey(people.alice.id, { workspaceId: WS_A, scope: 'read' });
        expect(texts(await client(readOnly).recall(mem, 'What does Alice do?'))[0]).toBe('Alice works at Google as a software engineer');
        expect(embed).toHaveBeenCalledTimes(1);
      } finally {
        embed.mockRestore();
      }
    });

    it('refuses a floor on a reranker that does not run, and a window that ends before it starts', async () => {
      const post = (body: unknown) => call(people.alice.key, 'POST', `/v1/default/banks/${mem}/memories/recall`, body);
      const reranker = await post({ query: 'Alice', min_scores: { reranker: 0.5 } });
      expect(reranker.status).toBe(400);
      expect((await reranker.json()).detail).toMatch(/reranker/);
      expect((await post({ query: 'Alice', temporal_window: { start: '2026-02-01T00:00:00Z', end: '2026-01-01T00:00:00Z' } })).status).toBe(400);
      expect((await post({ query: '' })).status).toBe(422);
      // Asked to prune with no decision model routed: the flag is ignored.
      const pruned = await post({ query: 'What does Alice do?', rerank: { prune: true }, tag_groups: [], trace: true });
      expect(pruned.status).toBe(200);
      expect((await pruned.json()).results.length).toBeGreaterThan(0);
    });

    it('keeps memory out of page search', async () => {
      const page = await call(people.alice.key, 'POST', '/v1/search', { workspaceId: WS_A, query: 'Alice works at Google as a software engineer', limit: 10 });
      expect(JSON.stringify(await page.json())).not.toContain('software engineer');
    });
  });
});
