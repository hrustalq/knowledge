import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #636 phase 3 acceptance: a project is a read-only git remote. Real `git`
 * against the git process (in this process, on a random port), with real
 * people and keys in `AUTH_MODE=api-key`, because the dev principal sees
 * everything:
 *
 *   admin — workspace admin (not a platform admin)
 *   alice — editor, granted the restricted page
 *   bob   — editor, not granted it
 *   gus   — guest
 *
 * Needs `make infra-up` (Postgres, Redis, MinIO, ArcadeDB). No indexing is
 * awaited: a commit is written at finalize. Each run makes a fresh project and
 * destroys the earlier runs' projects.
 */

const WORKSPACE = '63600000-0000-4636-8636-000000000636';
const run = promisify(execFile);

type Person = { id: string; key: string; read: string; capture: string };

describe('git remote, read side (e2e, #636)', () => {
  let app: INestApplication;
  let gitApp: NestExpressApplication;
  let prisma: PrismaService;
  let port: number;
  let projectId: string;
  const nonce = randomUUID().slice(0, 8);
  const people = {} as Record<'admin' | 'alice' | 'bob' | 'gus', Person>;
  const ids = {} as Record<'open' | 'secret', string>;
  const slugs = {} as Record<'open' | 'secret', string>;
  const cache = mkdtempSync(join(tmpdir(), 'git-e2e-cache-'));
  const work = mkdtempSync(join(tmpdir(), 'git-e2e-work-'));

  const http = () => request(app.getHttpServer());
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  const as = (key: string) => ({ Authorization: `Bearer ${key}` });
  const repo = (key: string, workspace = WORKSPACE) => `http://x:${key}@127.0.0.1:${port}/git/${workspace}/${projectId}.git`;
  const git = async (args: string[], cwd = work) =>
    (await run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANG: 'C' } })).stdout.trim();
  const clone = async (key: string, name: string) => {
    await git(['clone', '-q', repo(key), name]);
    return join(work, name);
  };
  /** One raw smart-HTTP call, to read a refusal's status and the text git would print. */
  const refs = (auth: string | null, path = `${WORKSPACE}/${projectId}.git`, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/git/${path}/info/refs?service=git-upload-pack`, {
      headers: { ...(auth ? { Authorization: `Basic ${Buffer.from(`x:${auth}`).toString('base64')}` } : {}), ...headers },
    }).then(async (r) => ({ status: r.status, text: (await r.text()).trim() }));

  async function key(userId: string, scope: string): Promise<string> {
    const value = `kn_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: { userId, name: `git e2e ${nonce}`, keyHash: createHash('sha256').update(value).digest('hex'), prefix: value.slice(0, 11), scope },
    });
    return value;
  }

  async function person(name: string, role: string): Promise<Person> {
    const email = `git-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Git ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    return { id: user.id, key: await key(user.id, 'write'), read: await key(user.id, 'read'), capture: await key(user.id, 'capture') };
  }

  async function write(p: Person, documentId: string, branch: string, content: string): Promise<void> {
    const res = await http()
      .post('/v1/mcp')
      .set({ ...as(p.key), Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge_create_revision', arguments: { documentId, branch, content } } })
      .expect(ok(200));
    expect(res.body.result.isError).toBeFalsy();
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    process.env.GIT_REMOTE_ENABLED = 'true';
    process.env.GIT_CACHE_DIR = cache;
    const [{ createE2eApp }, { NestFactory }, { GitModule }, { PrismaService }] = await Promise.all([
      import('./e2e-app.js'),
      import('@nestjs/core'),
      import('../src/git/git.module.js'),
      import('../src/prisma/prisma.service.js'),
    ]);
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    gitApp = await NestFactory.create<NestExpressApplication>(GitModule, { bodyParser: false, logger: false });
    await gitApp.listen(0, '127.0.0.1');
    port = (gitApp.getHttpServer().address() as AddressInfo).port;

    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Git e2e (#636)' } });
    people.admin = await person('admin', 'admin');
    people.alice = await person('alice', 'editor');
    people.bob = await person('bob', 'editor');
    people.gus = await person('gus', 'guest');
    projectId = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Git e2e ${nonce}` } })).id;
    for (const old of await prisma.project.findMany({ where: { workspaceId: WORKSPACE, id: { not: projectId } } })) {
      await http().delete(`/v1/projects/${old.id}`).query({ mode: 'cascade', confirm: old.name }).set(as(people.admin.key)).expect(ok(200));
    }
    for (const [name, title] of [['open', `Open handbook ${nonce}`], ['secret', `Payroll ledger ${nonce}`]] as const) {
      const res = await http()
        .post('/v1/documents')
        .set(as(people.admin.key))
        .send({ workspaceId: WORKSPACE, projectId, title, visibility: 'workspace', content: { mode: 'inline', format: 'markdown', text: `# ${title}\n\nFirst text.\n` } })
        .expect(ok(201));
      ids[name] = res.body.documentId;
    }
    await http()
      .put(`/v1/documents/${ids.secret}/access`)
      .set(as(people.admin.key))
      .send({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.alice.id, level: 'view' }] })
      .expect(ok(200));
    for (const d of await prisma.document.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true, slug: true } })) {
      slugs[d.id === ids.open ? 'open' : 'secret'] = d.slug!;
    }
  }, 120_000);

  afterAll(async () => {
    await prisma?.apiKey.deleteMany({ where: { name: `git e2e ${nonce}` } });
    await gitApp?.close();
    await app?.close();
    rmSync(cache, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it('clones what the key owner may open; equal access gives equal SHAs', async () => {
    const alice = await clone(people.alice.read, 'alice');
    const bob = await clone(people.bob.read, 'bob');
    const bob2 = await clone(people.bob.key, 'bob2');
    const admin = await clone(people.admin.read, 'admin');
    expect((await git(['ls-files'], alice)).split('\n').sort()).toEqual([`${slugs.open}.md`, `${slugs.secret}.md`].sort());
    expect(await git(['ls-files'], bob)).toBe(`${slugs.open}.md`);
    expect(readFileSync(join(bob, `${slugs.open}.md`), 'utf8')).toMatch(new RegExp(`^---\\nknowledge-id: ${ids.open}\\n---\\n# Open handbook`));
    expect(await git(['rev-parse', 'HEAD'], bob)).toBe(await git(['rev-parse', 'HEAD'], bob2));
    expect(await git(['rev-parse', 'HEAD'], admin)).toBe(await git(['rev-parse', 'HEAD'], alice));
    expect(await git(['rev-parse', 'HEAD'], bob)).not.toBe(await git(['rev-parse', 'HEAD'], alice));
    expect(await git(['log', '--all', '--format=%H', '--', `${slugs.secret}.md`], bob)).toBe('');
    await git(['fsck', '--strict'], alice);
  });

  it('shows a web edit on the next fetch', async () => {
    await write(people.admin, ids.open, 'main', `# Open handbook ${nonce}\n\nEdited in the web.\n`);
    const bob = join(work, 'bob');
    await git(['pull', '-q', '--ff-only'], bob);
    expect(readFileSync(join(bob, `${slugs.open}.md`), 'utf8')).toContain('Edited in the web.');
    expect(await git(['log', '--format=%an <%ae>', '-1'], bob)).toBe(`Git admin <${people.admin.id}@users.noreply.knowledge>`);
  });

  it('serves a private draft branch to its owner only', async () => {
    await http().post(`/v1/documents/${ids.open}/branches/mine`).set(as(people.alice.key)).expect(ok(201));
    const draft = `draft/${people.alice.id}`;
    await write(people.alice, ids.open, draft, `# Open handbook ${nonce}\n\nAlice's private rewrite.\n`);
    expect(await git(['ls-remote', '--heads', repo(people.alice.read)])).toContain(`refs/heads/${draft}`);
    expect(await git(['ls-remote', '--heads', repo(people.bob.read)])).not.toContain('draft/');
  });

  it('refuses with a reason git prints', async () => {
    expect((await refs(null)).status).toBe(401);
    expect((await refs('kn_not-a-key')).status).toBe(401);
    expect(await refs(people.alice.capture)).toMatchObject({ status: 403, text: expect.stringMatching(/capture key/) });
    // A guest learns nothing of a project they hold no grant on; one granted it is still refused in v1.
    expect((await refs(people.gus.read)).status).toBe(404);
    await prisma.accessGrant.create({
      data: { workspaceId: WORKSPACE, resourceType: 'project', resourceId: projectId, subjectType: 'user', subjectId: people.gus.id, level: 'view', createdBy: people.admin.id },
    });
    expect(await refs(people.gus.read)).toMatchObject({ status: 403, text: expect.stringMatching(/Guests/) });
    expect((await refs(people.bob.read, `11111111-1111-4111-8111-111111111111/${projectId}.git`)).status).toBe(404);
    expect(await refs(people.bob.read, undefined, { 'Accept-Language': 'ru' })).toMatchObject({ status: 200 });
    expect(await refs(people.gus.read, undefined, { 'Accept-Language': 'ru' })).toMatchObject({ status: 403, text: expect.stringMatching(/Гостям/) });
    await expect(git(['push', repo(people.bob.key), 'HEAD:refs/heads/x'], join(work, 'bob'))).rejects.toThrow(/read-only/);
  });

  it('404s with the workspace toggle off', async () => {
    const { FeaturesService } = await import('../src/auth/features.service.js');
    const features = gitApp.get(FeaturesService);
    await features.set(WORKSPACE, ['git'], people.admin.id);
    try {
      expect((await refs(people.bob.read)).status).toBe(404);
    } finally {
      await features.set(WORKSPACE, [], people.admin.id);
    }
  });
});
