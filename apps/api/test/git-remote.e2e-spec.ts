import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import { vi } from 'vitest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #636 phases 3, 4 and 5a acceptance: a project is a git remote. Real `git`
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
 * destroys the earlier runs' projects. The tests run in order and share state.
 */

const WORKSPACE = '63600000-0000-4636-8636-000000000636';
const run = promisify(execFile);

type Person = { id: string; key: string; read: string; capture: string };

describe('git remote (e2e, #636)', () => {
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
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    GIT_AUTHOR_NAME: 'Alice Laptop',
    GIT_AUTHOR_EMAIL: 'alice@laptop.test',
    GIT_COMMITTER_NAME: 'Alice Laptop',
    GIT_COMMITTER_EMAIL: 'alice@laptop.test',
    // No credential helper (osxkeychain on a Mac): this spec's keys stay out of the keychain.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    ...extra,
  });
  const git = async (args: string[], cwd = work) => (await run('git', args, { cwd, env: env() })).stdout.trim();
  /** stdout and stderr, where git prints `remote:` lines. */
  const gitAll = async (args: string[], cwd = work, extra: Record<string, string> = {}) => {
    const r = await run('git', args, { cwd, env: env(extra) });
    return `${r.stdout}\n${r.stderr}`;
  };
  /** A failing git's whole output. */
  const gitFails = (args: string[], cwd = work, extra: Record<string, string> = {}) =>
    run('git', args, { cwd, env: env(extra) }).then(
      (r) => {
        throw new Error(`git ${args.join(' ')} succeeded: ${r.stderr}`);
      },
      (e: { stdout?: string; stderr?: string; message: string }) => `${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`,
    );
  const mrIdIn = (out: string) => /merge-requests\/([0-9a-f-]{36})/.exec(out)?.[1];
  const edit = (dir: string, file: string, fn: (text: string) => string) => writeFileSync(join(dir, file), fn(readFileSync(join(dir, file), 'utf8')));
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
    // Every credentialed git request counts against the per-IP limit, and this spec makes a few hundred.
    process.env.PUBLIC_RATE_LIMIT_PER_MIN = '100000';
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
    // The credential helper SKILL.md hands out: the key from the environment, never in a URL.
    const helper = '!f() { echo username=knowledge; echo "password=$KNOWLEDGE_API_KEY"; }; f';
    await gitAll(['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'clone', '-q', `http://127.0.0.1:${port}/git/${WORKSPACE}/${projectId}.git`, 'helper'], work, {
      KNOWLEDGE_API_KEY: people.bob.read,
    });
    expect(await git(['rev-parse', 'HEAD'], join(work, 'helper'))).toBe(await git(['rev-parse', 'HEAD'], bob));
    // The web's Clone button reads its URL here; a guest without a grant gets the 404 a guest always gets.
    const info = await http().get(`/v1/projects/${projectId}/git`).set(as(people.bob.read)).expect(ok(200));
    expect(info.body.url).toMatch(new RegExp(`/git/${WORKSPACE}/${projectId}\\.git$`));
    await http().get(`/v1/projects/${projectId}/git`).set(as(people.gus.key)).expect(404);
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
    await expect(git(['push', repo(people.bob.read), 'HEAD:refs/heads/x'], join(work, 'bob'))).rejects.toThrow(/read-only/);
  });

  // --- Write side (phase 4) -------------------------------------------------

  /** A page admin creates on main; its file name. */
  async function page(title: string, text: string, parentId?: string): Promise<{ id: string; slug: string }> {
    const res = await http()
      .post('/v1/documents')
      .set(as(people.admin.key))
      .send({ workspaceId: WORKSPACE, projectId, title, parentId, visibility: 'workspace', content: { mode: 'inline', format: 'markdown', text } })
      .expect(ok(201));
    const row = await prisma.document.findUniqueOrThrow({ where: { id: res.body.documentId }, select: { slug: true } });
    return { id: res.body.documentId, slug: row.slug! };
  }
  const approveAndMerge = async (mrId: string) => {
    await http().post(`/v1/merge-requests/${mrId}/approve`).set(as(people.admin.key)).expect(ok(201));
    return http().post(`/v1/merge-requests/${mrId}/merge`).set(as(people.admin.key)).send({});
  };
  let guide: { id: string; slug: string };

  it('pushes a branch with -o merge_request.create; the MR spans both pages, a web merge lands both, and git pull fast-forwards', async () => {
    guide = await page(`Style guide ${nonce}`, `# Style guide ${nonce}\n\nOne.\n\nTwo.\n\nThree.\n`);
    const dir = await clone(people.alice.key, 'alice-w');
    edit(dir, `${slugs.open}.md`, (x) => `${x}\nA pushed line.\n`);
    edit(dir, `${guide.slug}.md`, (x) => x.replace('One.', 'One, pushed.'));
    await git(['commit', '-qam', 'Fix terms'], dir);
    const pushed = await git(['rev-parse', 'HEAD'], dir);
    const out = await gitAll(['push', '-o', 'merge_request.create', '-o', 'merge_request.title=Fix terms', 'origin', 'HEAD:fix-terms'], dir);
    const mrId = mrIdIn(out);
    expect(mrId).toBeTruthy();
    // Reproduce or refuse: the remote holds the commit with the SHA that was pushed.
    expect((await git(['ls-remote', repo(people.alice.read), 'refs/heads/fix-terms'])).split('\t')[0]).toBe(pushed);
    const diff = await http().get(`/v1/merge-requests/${mrId}/diff`).set(as(people.admin.key)).expect(ok(200));
    expect(diff.body.pages.map((p: { documentId: string }) => p.documentId).sort()).toEqual([ids.open, guide.id].sort());
    // Pushed revisions are attributed to the key's owner, whatever the commit's author line says.
    const rev = await prisma.documentRevision.findFirstOrThrow({ where: { documentId: guide.id, branch: { name: 'fix-terms' }, status: { not: 'draft' } } });
    expect(rev.authorId).toBe(people.alice.id);

    // Phase 5a: the branch is the project's — listed with both pages, its MR on each page and in the project's list.
    const branches = await http().get(`/v1/projects/${projectId}/branches`).set(as(people.bob.read)).expect(ok(200));
    const fix = branches.body.branches.find((b: { name: string }) => b.name === 'fix-terms');
    expect(fix.pages.map((p: { documentId: string }) => p.documentId).sort()).toEqual([ids.open, guide.id].sort());
    expect(fix).toMatchObject({ updatedBy: people.alice.id, openMergeRequest: { mergeRequestId: mrId } });
    // Alice's private draft branch on the same page is hers alone; main is every page's and never listed.
    expect(branches.body.branches.map((b: { name: string }) => b.name)).not.toContain(`draft/${people.alice.id}`);
    expect(branches.body.branches.map((b: { name: string }) => b.name)).not.toContain('main');
    for (const doc of [ids.open, guide.id]) {
      const list = await http().get(`/v1/documents/${doc}/merge-requests`).set(as(people.bob.read)).expect(ok(200));
      expect(list.body.mergeRequests.find((m: { mergeRequestId: string }) => m.mergeRequestId === mrId)).toMatchObject({ pageCount: 2 });
    }
    const inProject = await http().get('/v1/merge-requests').query({ workspaceId: WORKSPACE, projectId }).set(as(people.bob.read)).expect(ok(200));
    expect(inProject.body.mergeRequests.map((m: { mergeRequestId: string }) => m.mergeRequestId)).toContain(mrId);
    await vi.waitFor(async () => {
      const row = await prisma.activityLog.findFirstOrThrow({ where: { projectId, action: 'git.pushed', actor: people.alice.id } });
      expect(row.metadata).toMatchObject({ branch: 'fix-terms', commits: 1, pages: 2, sha: pushed });
    });

    expect((await approveAndMerge(mrId!)).status).toBe(201);
    await git(['pull', '-q', '--ff-only', 'origin', 'main'], dir);
    expect((await git(['log', '-1', '--format=%P'], dir)).split(' ')).toHaveLength(2);
    expect(readFileSync(join(dir, `${guide.slug}.md`), 'utf8')).toContain('One, pushed.');
    expect(await git(['log', '-1', '--format=%s'], dir)).toBe("Merge branch 'fix-terms' into 'main'");
    await git(['fsck', '--strict'], dir);
  });

  it('pushes straight to an unprotected default branch, and refuses a read key, a stale push, a force push and a protected branch, in en and ru', async () => {
    const a = join(work, 'alice-w');
    const b = await clone(people.alice.key, 'alice-w2');
    edit(a, `${guide.slug}.md`, (x) => x.replace('Three.', 'Three, direct.'));
    await git(['commit', '-qam', 'Direct edit'], a);
    await git(['push', '-q', 'origin', 'HEAD:main'], a);
    expect(await git(['ls-remote', repo(people.alice.read), 'refs/heads/main'])).toContain(await git(['rev-parse', 'HEAD'], a));
    expect(await prisma.documentRevision.count({ where: { documentId: guide.id, message: 'Direct edit', status: { not: 'draft' } } })).toBe(1);

    edit(b, `${guide.slug}.md`, (x) => x.replace(`# Style guide ${nonce}`, `# Style guide ${nonce}, second clone`));
    await git(['commit', '-qam', 'Stale edit'], b);
    expect(await gitFails(['push', repo(people.alice.read), 'HEAD:read-attempt'], b)).toMatch(/read-only/);
    expect(await gitFails(['push', 'origin', 'HEAD:main'], b)).toMatch(/fetch first/);
    expect(await gitFails(['push', '-f', 'origin', 'HEAD:main'], b)).toMatch(/non-fast-forward[\s\S]*immutable/);

    await git(['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'], b);
    await prisma.documentBranch.updateMany({ where: { documentId: guide.id, name: 'main' }, data: { protected: true } });
    try {
      expect(await gitFails(['push', 'origin', 'HEAD:main'], b)).toMatch(/'main' is protected[\s\S]*merge_request\.create/);
      expect(await gitFails(['push', 'origin', 'HEAD:main'], b, { LANGUAGE: 'ru' })).toMatch(/защищена/);
    } finally {
      await prisma.documentBranch.updateMany({ where: { documentId: guide.id, name: 'main' }, data: { protected: false } });
    }
    await git(['push', '-q', 'origin', 'HEAD:main'], b);
  });

  it('refuses what does not map onto pages', async () => {
    const dir = join(work, 'alice-w2');
    await git(['checkout', '-q', '-b', 'bad'], dir);
    writeFileSync(join(dir, 'notes.txt'), 'not a page\n');
    await git(['add', '.'], dir);
    await git(['commit', '-qm', 'A text file'], dir);
    expect(await gitFails(['push', 'origin', 'HEAD:bad'], dir)).toMatch(/notes\.txt: pages are \.md/);
    await git(['reset', '-q', '--hard', 'HEAD~1'], dir);
    edit(dir, `${guide.slug}.md`, (x) => x.replace(`knowledge-id: ${guide.id}`, `knowledge-id: ${ids.open}`));
    await git(['commit', '-qam', 'Wrong id'], dir);
    expect(await gitFails(['push', 'origin', 'HEAD:bad'], dir)).toMatch(/knowledge-id must stay/);
    await git(['reset', '-q', '--hard', 'HEAD~1'], dir);
    // A page's file moved without its directory's page cannot come back as pushed.
    mkdirSync(join(dir, 'deep'));
    writeFileSync(join(dir, 'deep', 'orphan.md'), '# Orphan\n');
    await git(['add', '.'], dir);
    await git(['commit', '-qm', 'Orphan'], dir);
    expect(await gitFails(['push', 'origin', 'HEAD:bad'], dir)).toMatch(/deep\/' needs a page 'deep\.md'/);
    await git(['checkout', '-q', 'main'], dir);
  });

  it('resolves an overlapping edit with git pull, and the merge request merges', async () => {
    const dir = join(work, 'alice-w');
    await git(['pull', '-q', '--ff-only', 'origin', 'main'], dir);
    await git(['checkout', '-q', '-b', 'conflict-a'], dir);
    edit(dir, `${guide.slug}.md`, (x) => x.replace('Two.', 'Two, from the branch.'));
    await git(['commit', '-qam', 'Branch side'], dir);
    const mrId = mrIdIn(await gitAll(['push', '-o', 'merge_request.create', 'origin', 'HEAD:conflict-a'], dir))!;
    const head = await prisma.documentBranch.findUniqueOrThrow({ where: { documentId_name: { documentId: guide.id, name: 'main' } } });
    const text = (await http().get(`/v1/documents/${guide.id}/content`).set(as(people.admin.key)).expect(ok(200))).body.markdown as string;
    await write(people.admin, guide.id, 'main', text.replace('Two.', 'Two, from the web.'));
    expect(head.headRevisionId).not.toBeNull();
    await http().post(`/v1/merge-requests/${mrId}/approve`).set(as(people.admin.key)).expect(ok(201));
    const refused = await http().post(`/v1/merge-requests/${mrId}/merge`).set(as(people.admin.key)).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.details.reason).toBe('conflict');

    expect(await gitFails(['pull', '--no-rebase', '--no-edit', 'origin', 'main'], dir)).toMatch(/CONFLICT/);
    edit(dir, `${guide.slug}.md`, (x) => x.replace(/<<<<<<< HEAD\n[\s\S]*?>>>>>>> [0-9a-f]+\n/, 'Two, from both.\n'));
    await git(['commit', '-qam', 'Resolve'], dir);
    await gitAll(['push', 'origin', 'HEAD:conflict-a'], dir);
    const merged = await http().post(`/v1/merge-requests/${mrId}/merge`).set(as(people.admin.key)).send({});
    expect(merged.status).toBe(201);
    await git(['checkout', '-q', 'main'], dir);
    await git(['pull', '-q', '--ff-only', 'origin', 'main'], dir);
    expect(readFileSync(join(dir, `${guide.slug}.md`), 'utf8')).toContain('Two, from both.');
  });

  it('merges by pushing a local merge commit once the gates pass', async () => {
    const dir = join(work, 'alice-w');
    await git(['checkout', '-q', '-b', 'by-push'], dir);
    edit(dir, `${slugs.open}.md`, (x) => `${x}\nMerged by push.\n`);
    await git(['commit', '-qam', 'By push'], dir);
    const mrId = mrIdIn(await gitAll(['push', '-o', 'merge_request.create', 'origin', 'HEAD:by-push'], dir))!;
    await git(['checkout', '-q', 'main'], dir);
    await git(['merge', '-q', '--no-ff', '--no-edit', 'by-push'], dir);
    expect(await gitFails(['push', 'origin', 'HEAD:main'], dir)).toMatch(/approval/);
    await http().post(`/v1/merge-requests/${mrId}/approve`).set(as(people.admin.key)).expect(ok(201));
    const local = await git(['rev-parse', 'HEAD'], dir);
    expect(await gitAll(['push', 'origin', 'HEAD:main'], dir)).toMatch(/Merged merge request/);
    expect((await git(['ls-remote', repo(people.admin.read), 'refs/heads/main'])).split('\t')[0]).toBe(local);
    const mr = await http().get(`/v1/merge-requests/${mrId}`).set(as(people.admin.key)).expect(ok(200));
    expect(mr.body.mergeRequest.status).toBe('merged');
  });

  it('git mv reparents, a new file opens a draft merge request, and git rm archives on merge', async () => {
    const stale = await page(`Stale notes ${nonce}`, `# Stale notes ${nonce}\n`);
    const dir = join(work, 'alice-w');
    await git(['pull', '-q', '--ff-only', 'origin', 'main'], dir);
    await git(['checkout', '-q', '-b', 'tree'], dir);
    mkdirSync(join(dir, slugs.open), { recursive: true });
    await git(['mv', `${guide.slug}.md`, `${slugs.open}/${guide.slug}.md`], dir);
    writeFileSync(join(dir, slugs.open, 'fresh-page.md'), '# Fresh page\n\nWritten in git.\n');
    await git(['rm', '-q', `${stale.slug}.md`], dir);
    await git(['add', '.'], dir);
    await git(['commit', '-qm', 'Reorganize'], dir);
    const out = await gitAll(['push', 'origin', 'HEAD:tree'], dir);
    const mrId = mrIdIn(out)!;
    expect(mrId).toBeTruthy();
    const fresh = await prisma.document.findFirstOrThrow({ where: { projectId, title: 'Fresh page' } });
    expect(fresh).toMatchObject({ pendingMergeRequestId: mrId, parentId: ids.open, slug: 'fresh-page' });
    expect((await prisma.mergeRequest.findUniqueOrThrow({ where: { id: mrId } })).isDraft).toBe(true);
    // Nothing reaches the default branch before the merge.
    expect((await prisma.document.findUniqueOrThrow({ where: { id: guide.id } })).parentId).toBeNull();

    await http().patch(`/v1/merge-requests/${mrId}`).set(as(people.alice.key)).send({ isDraft: false }).expect(ok(200));
    const merged = await approveAndMerge(mrId);
    expect(merged.status).toBe(201);
    expect(await prisma.document.findUniqueOrThrow({ where: { id: guide.id } })).toMatchObject({ parentId: ids.open });
    expect((await prisma.document.findUniqueOrThrow({ where: { id: stale.id } })).archivedAt).not.toBeNull();
    expect((await prisma.document.findUniqueOrThrow({ where: { id: fresh.id } })).pendingMergeRequestId).toBeNull();

    await git(['checkout', '-q', 'main'], dir);
    await git(['pull', '-q', '--ff-only', 'origin', 'main'], dir);
    expect(existsSync(join(dir, slugs.open, `${guide.slug}.md`))).toBe(true);
    expect(existsSync(join(dir, slugs.open, 'fresh-page.md'))).toBe(true);
    expect(existsSync(join(dir, `${stale.slug}.md`))).toBe(false);
    await git(['fsck', '--strict'], dir);
  });

  it('opens a merge request over MCP by project and branch name, and lists the branch', async () => {
    const mcp = (name: string, args: Record<string, unknown>) =>
      http()
        .post('/v1/mcp')
        .set({ ...as(people.bob.key), Accept: 'application/json, text/event-stream' })
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        .expect(ok(200))
        .then((res) => {
          expect(res.body.result.isError).toBeFalsy();
          return JSON.parse(res.body.result.content[0].text);
        });
    await mcp('knowledge_create_branch', { documentId: guide.id, name: 'mcp-terms' });
    await write(people.bob, guide.id, 'mcp-terms', `# Style guide ${nonce}\n\nOne, from MCP.\n`);
    const listed = await mcp('knowledge_list_branches', { projectId });
    expect(listed.branches.find((b: { name: string }) => b.name === 'mcp-terms').pages).toEqual([{ documentId: guide.id, title: `Style guide ${nonce}` }]);
    const opened = await mcp('knowledge_create_merge_request', { projectId, sourceBranch: 'mcp-terms', title: 'Terms over MCP' });
    expect(opened.mergeRequest).toMatchObject({ documentId: guide.id, pageCount: 1 });
  });

  it('404s with the workspace toggle off', async () => {
    const { FeaturesService } = await import('../src/auth/features.service.js');
    // Each process caches the toggle, so both are told.
    const both = (off: 'git'[]) => Promise.all([gitApp, app].map((a) => a.get(FeaturesService).set(WORKSPACE, off, people.admin.id)));
    await both(['git']);
    try {
      expect((await refs(people.bob.read)).status).toBe(404);
      await http().get(`/v1/projects/${projectId}/git`).set(as(people.bob.read)).expect(404);
    } finally {
      await both([]);
    }
  });
});
