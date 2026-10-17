import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #74 styleguide acceptance, end to end against live infra: the routes, for
 * real people with real API keys.
 *
 *   - an admin writes a workspace styleguide and a project override;
 *   - `GET ?projectId=` returns the project's for that project and the
 *     workspace's for any other — the override replaces, never merges;
 *   - a member reads the rules they are held to, but cannot write them;
 *   - a styleguide never shows up as a skill.
 *
 * Like quality.e2e-spec.ts it forces `AUTH_MODE=api-key`: the dev principal
 * would pass the admin check for the wrong reason. Needs `make infra-up`
 * only. Each run uses a fresh pair of projects and removes its rows.
 */

const WORKSPACE = '74000000-0000-4074-8074-0000000005a1';

type Person = { id: string; key: string; keyId: string };

describe('styleguides (e2e, #74)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const nonce = randomUUID().slice(0, 8);
  const people = {} as Record<'admin' | 'eve', Person>;
  /** P has its own styleguide; Q inherits the workspace's. */
  const projects = {} as Record<'P' | 'Q', string>;

  const http = () => request(app.getHttpServer());
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });

  async function person(name: string, role: 'admin' | 'editor'): Promise<Person> {
    const email = `styleguide-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Styleguide ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: {
        userId: user.id,
        name: `styleguide e2e ${nonce}`,
        keyHash: createHash('sha256').update(key).digest('hex'),
        prefix: key.slice(0, 11),
        scope: 'write',
      },
    });
    return { id: user.id, key, keyId: row.id };
  }

  const guide = (name: string, projectId: string | null, ruleId: string) => ({
    workspaceId: WORKSPACE,
    projectId,
    name,
    description: `${name} ${nonce}`,
    rules: [{ id: ruleId, text: `Rule ${ruleId}.`, severity: 'error', enabled: true }],
  });

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [{ createE2eApp }, { PrismaService }] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/prisma/prisma.service.js'),
    ]);
    app = await createE2eApp();
    prisma = app.get(PrismaService);

    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Styleguide e2e (#74)' } });
    // A previous run that died before its afterAll leaves its workspace guide behind.
    await prisma.aiSkill.deleteMany({ where: { workspaceId: WORKSPACE, kind: 'styleguide' } });
    people.admin = await person('admin', 'admin');
    people.eve = await person('eve', 'editor');
    for (const key of ['P', 'Q'] as const) {
      projects[key] = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Styleguide ${key} ${nonce}` } })).id;
    }
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    await prisma.aiSkill.deleteMany({ where: { workspaceId: WORKSPACE, kind: 'styleguide' } });
    const projectIds = Object.values(projects);
    if (projectIds.length) await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    const keyIds = Object.values(people).map((p) => p.keyId);
    if (keyIds.length) await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  it('refuses a styleguide write from a non-admin', async () => {
    await http().put('/v1/ai/styleguides').set(as(people.eve)).send(guide('House style', null, 'ws-rule')).expect(ok(403));
    await http().put('/v1/ai/styleguides').set(as(people.eve)).send(guide('Docs style', projects.P, 'p-rule')).expect(ok(403));
  });

  it('serves the project override to its project and the workspace styleguide to every other', async () => {
    const ws = await http().put('/v1/ai/styleguides').set(as(people.admin)).send(guide('House style', null, 'ws-rule')).expect(ok(200));
    expect(ws.body).toMatchObject({ projectId: null, rules: [{ id: 'ws-rule' }] });
    const p = await http().put('/v1/ai/styleguides').set(as(people.admin)).send(guide('Docs style', projects.P, 'p-rule')).expect(ok(200));
    expect(p.body).toMatchObject({ projectId: projects.P, rules: [{ id: 'p-rule' }] });

    // An editor reads what they are held to.
    const forP = await http().get('/v1/ai/styleguides').query({ workspaceId: WORKSPACE, projectId: projects.P }).set(as(people.eve)).expect(ok(200));
    expect(forP.body).toMatchObject({ scope: 'project', styleguide: { id: p.body.id, rules: [{ id: 'p-rule' }] } });
    expect(forP.body.styleguide.rules).toHaveLength(1);

    const forQ = await http().get('/v1/ai/styleguides').query({ workspaceId: WORKSPACE, projectId: projects.Q }).set(as(people.eve)).expect(ok(200));
    expect(forQ.body).toMatchObject({ scope: 'workspace', styleguide: { id: ws.body.id, rules: [{ id: 'ws-rule' }] } });

    const forWorkspace = await http().get('/v1/ai/styleguides').query({ workspaceId: WORKSPACE }).set(as(people.eve)).expect(ok(200));
    expect(forWorkspace.body).toMatchObject({ scope: 'workspace', styleguide: { id: ws.body.id } });

    // Neither is a skill.
    const skills = await http().get('/v1/ai/skills').query({ workspaceId: WORKSPACE }).set(as(people.eve)).expect(ok(200));
    const skillIds = (skills.body.skills as Array<{ id: string }>).map((s) => s.id);
    expect(skillIds).not.toContain(ws.body.id);
    expect(skillIds).not.toContain(p.body.id);
  });

  it('falls a project back to the workspace styleguide once its own is deleted', async () => {
    const current = await http().get('/v1/ai/styleguides').query({ workspaceId: WORKSPACE, projectId: projects.P }).set(as(people.admin)).expect(ok(200));
    expect(current.body.scope).toBe('project');
    await http().delete(`/v1/ai/styleguides/${current.body.styleguide.id}`).set(as(people.eve)).expect(ok(403));
    await http().delete(`/v1/ai/styleguides/${current.body.styleguide.id}`).set(as(people.admin)).expect(ok(200));
    const after = await http().get('/v1/ai/styleguides').query({ workspaceId: WORKSPACE, projectId: projects.P }).set(as(people.admin)).expect(ok(200));
    expect(after.body).toMatchObject({ scope: 'workspace', styleguide: { projectId: null } });
  });
});
