import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HindsightClient, sdk } from '@vectorize-io/hindsight-client';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { FeaturesService } from '../src/auth/features.service.js';

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
    const [{ createE2eApp }, { PrismaService }] = await Promise.all([import('./e2e-app.js'), import('../src/prisma/prisma.service.js')]);
    app = await createE2eApp();
    prisma = app.get(PrismaService);
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
});
