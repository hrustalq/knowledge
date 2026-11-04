import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The page-access gaps found together on 2026-11-04, against the real guards:
 * reports (#758), staged run items (#767), chat threads (#772), subscriptions
 * (#773), template rendering (#774) and a guest's inbox (#777). Real people and
 * keys in `AUTH_MODE=api-key`, because the dev principal sees everything:
 *
 *   admin — workspace admin (not a platform admin)
 *   alice — editor, granted the restricted page
 *   bob   — editor, not granted it
 *   gus   — guest, granted the open page
 *
 * Needs `make infra-up`. Nothing waits for indexing. Each run makes a fresh
 * project and destroys the earlier runs'.
 */

const WORKSPACE = '75400000-0000-4754-8754-000000000754';

type Person = { id: string; key: string };

describe('restricted surfaces (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let projectId: string;
  let openId: string;
  let secretId: string;
  const nonce = randomUUID().slice(0, 8);
  const SECRET_TITLE = `Payroll ledger ${nonce}`;
  const people = {} as Record<'admin' | 'alice' | 'bob' | 'gus', Person>;

  const http = () => request(app.getHttpServer());
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  /** The standard refusal: 403, and nothing of the page in it. */
  const refused = (res: request.Response) => {
    if (res.status !== 403) throw new Error(`${res.status} (wanted 403): ${JSON.stringify(res.body)}`);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TITLE);
  };

  async function person(name: string, role: string): Promise<Person> {
    const email = `surfaces-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Surfaces ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    const value = `kn_${randomBytes(24).toString('hex')}`;
    await prisma.apiKey.create({
      data: { userId: user.id, name: `surfaces e2e ${nonce}`, keyHash: createHash('sha256').update(value).digest('hex'), prefix: value.slice(0, 11), scope: 'write' },
    });
    return { id: user.id, key: value };
  }

  async function page(title: string): Promise<string> {
    const res = await http()
      .post('/v1/documents')
      .set(as(people.admin))
      .send({ workspaceId: WORKSPACE, projectId, title, visibility: 'workspace', content: { mode: 'inline', format: 'markdown', text: `# ${title}\n\nFirst text.\n` } })
      .expect(ok(201));
    return res.body.documentId as string;
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [{ createE2eApp }, { PrismaService }] = await Promise.all([import('./e2e-app.js'), import('../src/prisma/prisma.service.js')]);
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Surfaces e2e' } });
    people.admin = await person('admin', 'admin');
    people.alice = await person('alice', 'editor');
    people.bob = await person('bob', 'editor');
    people.gus = await person('gus', 'guest');
    projectId = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Surfaces ${nonce}` } })).id;
    for (const old of await prisma.project.findMany({ where: { workspaceId: WORKSPACE, id: { not: projectId } } })) {
      await http().delete(`/v1/projects/${old.id}`).query({ mode: 'cascade', confirm: old.name }).set(as(people.admin)).expect(ok(200));
    }
    openId = await page(`Open handbook ${nonce}`);
    secretId = await page(SECRET_TITLE);
    await http()
      .put(`/v1/documents/${secretId}/access`)
      .set(as(people.admin))
      .send({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.alice.id, level: 'view' }] })
      .expect(ok(200));
    await http()
      .put(`/v1/documents/${openId}/access`)
      .set(as(people.admin))
      .send({ restricted: false, grants: [{ subjectType: 'user', subjectId: people.gus.id, level: 'view' }] })
      .expect(ok(200));
  }, 120_000);

  afterAll(async () => {
    await prisma?.apiKey.deleteMany({ where: { name: `surfaces e2e ${nonce}` } });
    await app?.close();
  });

  it('keeps reports on a restricted page from a member who cannot open it (#758)', async () => {
    const report = { workspaceId: WORKSPACE, documentId: secretId, kind: 'stale', detail: `Quote from ${SECRET_TITLE}` };
    const filed = await http().post('/v1/knowledge-issues').set(as(people.admin)).send(report).expect(ok(201));
    const issueId = filed.body.issue.id as string;

    const asBob = await http().get('/v1/knowledge-issues').query({ workspaceId: WORKSPACE }).set(as(people.bob)).expect(ok(200));
    expect(asBob.body.issues).toEqual([]);
    const asAlice = await http().get('/v1/knowledge-issues').query({ workspaceId: WORKSPACE }).set(as(people.alice)).expect(ok(200));
    expect(asAlice.body.issues.map((i: { id: string }) => i.id)).toContain(issueId);

    await http().post('/v1/knowledge-issues').set(as(people.bob)).send(report).expect(refused);
    await http().patch(`/v1/knowledge-issues/${issueId}`).set(as(people.bob)).send({ status: 'dismissed' }).expect(refused);
    expect((await prisma.knowledgeIssue.findUniqueOrThrow({ where: { id: issueId } })).status).not.toBe('dismissed');
  });

  it('refuses a staged run item for a page the caller cannot open (#767)', async () => {
    const connector = await prisma.connector.create({
      data: { workspaceId: WORKSPACE, projectId, kind: 'markdown', name: `Surfaces ${nonce}`, config: {}, createdBy: people.admin.id },
    });
    const run = await prisma.connectorRun.create({
      data: { connectorId: connector.id, workspaceId: WORKSPACE, direction: 'pull', trigger: 'manual', status: 'awaiting-review', mode: 'review', locale: 'en' },
    });
    const item = await prisma.connectorRunItem.create({
      data: { runId: run.id, externalId: 'docs/payroll.md', title: SECRET_TITLE, depth: 0, position: 0, status: 'staged', action: 'update', documentId: secretId },
    });
    await http().get(`/v1/connectors/runs/${run.id}/items/${item.id}`).set(as(people.bob)).expect(refused);
    const list = await http().get(`/v1/connectors/runs/${run.id}/items`).set(as(people.bob)).expect(ok(200));
    expect(JSON.stringify(list.body)).not.toMatch(new RegExp(`${SECRET_TITLE}|payroll`));
    expect(list.body.items).toHaveLength(1);

    const asAlice = await http().get(`/v1/connectors/runs/${run.id}/items/${item.id}`).set(as(people.alice)).expect(ok(200));
    expect(asAlice.body.localHead).toContain('First text.');
  });

  it('keeps a chat thread to the person who asked (#772)', async () => {
    const created = await http().post('/v1/assistant/threads').set(as(people.alice)).send({ workspaceId: WORKSPACE }).expect(ok(201));
    const thread = created.body.thread.id as string;
    const list = (p: Person) => http().get('/v1/assistant/threads').query({ workspaceId: WORKSPACE }).set(as(p)).expect(ok(200));

    expect((await list(people.bob)).body.threads).toEqual([]);
    expect((await list(people.alice)).body.threads.map((t: { id: string }) => t.id)).toEqual([thread]);
    await http().get(`/v1/assistant/threads/${thread}`).set(as(people.bob)).expect(ok(404));
    await http().patch(`/v1/assistant/threads/${thread}`).set(as(people.bob)).send({ title: 'Mine now' }).expect(ok(404));
    await http().delete(`/v1/assistant/threads/${thread}/messages/${randomUUID()}`).set(as(people.bob)).expect(ok(404));
    await http().delete(`/v1/assistant/threads/${thread}`).set(as(people.bob)).expect(ok(404));

    await http().patch(`/v1/assistant/threads/${thread}`).set(as(people.alice)).send({ title: 'Still hers' }).expect(ok(200));
    await http().get(`/v1/assistant/threads/${thread}`).set(as(people.alice)).expect(ok(200));
    // Bypass is no way in either: an answer can quote pages only its asker may open.
    await http().get(`/v1/assistant/threads/${thread}`).set(as(people.admin)).expect(ok(404));
    await http().delete(`/v1/assistant/threads/${thread}`).set(as(people.alice)).expect(ok(200));
  });

  it('names a watched page only to someone who can open it (#773)', async () => {
    const body = { workspaceId: WORKSPACE, subjectType: 'document', subjectId: secretId };
    await http().put('/v1/notifications/subscriptions').set(as(people.bob)).send({ ...body, state: 'watching' }).expect(refused);

    const muted = await http().put('/v1/notifications/subscriptions').set(as(people.bob)).send({ ...body, state: 'muted' }).expect(ok(200));
    expect(muted.body.subscriptions).toMatchObject([{ subjectId: secretId, state: 'muted', title: null }]);
    expect(JSON.stringify(muted.body)).not.toContain(SECRET_TITLE);

    const watched = await http().put('/v1/notifications/subscriptions').set(as(people.alice)).send({ ...body, state: 'watching' }).expect(ok(200));
    expect(watched.body.subscriptions[0].title).toBe(SECRET_TITLE);
  });

  it('renders a page the caller cannot open as if it were not given (#774)', async () => {
    const created = await http()
      .post('/v1/templates')
      .set(as(people.admin))
      .send({ workspaceId: WORKSPACE, name: `Links ${nonce}`, source: '---\ntemplate:\n  placeholders: [{ name: linked, kind: page }]\n---\n[{{parent}}] [{{linked}}]\n' })
      .expect(ok(201));
    const render = (p: Person) =>
      http()
        .post('/v1/templates/render')
        .set(as(p))
        .send({ workspaceId: WORKSPACE, ref: created.body.id, parentId: secretId, values: { linked: secretId } })
        .expect(ok(201));
    expect(JSON.stringify((await render(people.bob)).body)).not.toContain(SECRET_TITLE);
    expect((await render(people.alice)).body.body).toContain(`[${SECRET_TITLE}]`);
  });

  it('lets a guest read and clear what they were sent, and nothing wider (#777)', async () => {
    const note = await prisma.notification.create({
      data: { workspaceId: WORKSPACE, userId: people.gus.id, type: 'access.granted', reason: 'participant', documentId: openId, title: 'Open handbook' },
    });
    const query = { workspaceId: WORKSPACE };
    const inbox = await http().get('/v1/notifications').query(query).set(as(people.gus)).expect(ok(200));
    expect(inbox.body.entries.map((n: { id: string }) => n.id)).toContain(note.id);
    const count = await http().get('/v1/notifications/unread-count').query(query).set(as(people.gus)).expect(ok(200));
    expect(count.body.count).toBeGreaterThan(0);
    await http().post('/v1/notifications/read').set(as(people.gus)).send({ ...query, ids: [note.id] }).expect(ok(200));
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: note.id } })).readAt).not.toBeNull();
    await http().get('/v1/notifications/subscriptions').query(query).set(as(people.gus)).expect(ok(403));
  });
});
