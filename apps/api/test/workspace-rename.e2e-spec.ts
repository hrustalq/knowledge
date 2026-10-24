import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #478 acceptance against live infra (`make infra-up`): only a workspace admin
 * renames, the name follows the create rule, and the audit row keeps both names.
 * `AUTH_MODE=api-key` with non-platform-admin people, as in workspace-delete.
 */
type Person = { id: string; key: string };

describe('workspace rename (e2e, #478)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const nonce = randomUUID().slice(0, 8);
  const workspaceId = randomUUID();
  const name = `Typo ${nonce}`;
  let admin: Person;
  let editor: Person;
  let viewer: Person;
  let outsider: Person;

  const http = () => request(app.getHttpServer());
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };

  async function person(role: 'admin' | 'editor' | 'viewer' | null): Promise<Person> {
    const user = await prisma.user.create({
      data: { email: `ws-rename-${role ?? 'outsider'}-${nonce}@example.test`, displayName: `Rename ${role}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    if (role) await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role } });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: { userId: user.id, name: `rename e2e ${nonce}`, keyHash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 11), scope: 'write' },
    });
    return { id: user.id, key };
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [e2e, prismaMod] = await Promise.all([import('./e2e-app.js'), import('../src/prisma/prisma.service.js')]);
    app = await e2e.createE2eApp();
    prisma = app.get(prismaMod.PrismaService);
    await prisma.workspace.create({ data: { id: workspaceId, name } });
    admin = await person('admin');
    editor = await person('editor');
    viewer = await person('viewer');
    outsider = await person(null);
  });

  afterAll(async () => {
    await prisma?.auditLog.deleteMany({ where: { workspaceId } });
    await prisma?.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma?.user.deleteMany({ where: { email: { contains: `-${nonce}@example.test` } } });
    await prisma?.workspace.deleteMany({ where: { id: workspaceId } });
    await app?.close();
  });

  it('refuses everyone but a workspace admin, and an empty name', async () => {
    for (const p of [editor, viewer]) {
      await http().patch(`/v1/workspaces/${workspaceId}`).set(as(p)).send({ name: 'Nope' }).expect(ok(403));
    }
    const res = await http().patch(`/v1/workspaces/${workspaceId}`).set(as(outsider)).send({ name: 'Nope' });
    expect([403, 404]).toContain(res.status);
    await http().patch(`/v1/workspaces/${workspaceId}`).set(as(admin)).send({ name: '   ' }).expect(ok(400));
    await http().patch(`/v1/workspaces/${workspaceId}`).set(as(admin)).send({ name: 'x'.repeat(121) }).expect(ok(400));
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).name).toBe(name);
  });

  it('renames, trimmed, lists the new name and audits both', async () => {
    const renamed = `Fixed ${nonce}`;
    const res = await http().patch(`/v1/workspaces/${workspaceId}`).set(as(admin)).send({ name: `  ${renamed} ` }).expect(ok(200));
    expect(res.body).toEqual({ workspaceId, name: renamed });
    const list = await http().get('/v1/workspaces').set(as(viewer)).expect(ok(200));
    expect(list.body.workspaces.find((w: { workspaceId: string }) => w.workspaceId === workspaceId)?.name).toBe(renamed);
    // The audit write is fire-and-forget.
    await new Promise((r) => setTimeout(r, 200));
    const rows = await prisma.auditLog.findMany({ where: { workspaceId, action: 'workspace.renamed' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: admin.id, params: { from: name, to: renamed } });
  });
});
