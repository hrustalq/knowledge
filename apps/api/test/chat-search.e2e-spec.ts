import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { GraphService } from '../src/graph/graph.service.js';

/**
 * #339 phase 3 acceptance, end to end against live infra: chat search holds
 * a binding's project audience for real people with real API keys.
 *
 * Like page-permissions.e2e-spec.ts it forces `AUTH_MODE=api-key` (the dev
 * principal bypasses everything) and makes its own non-platform-admin people:
 *
 *   admin — workspace admin
 *   alice — editor with a view grant on the restricted project
 *   bob   — editor with none
 *   gus   — guest with a view grant on one open project
 *
 * Five bindings: an open project's, a restricted project's, the guest's
 * project's, a project-less one (the whole workspace), and one never made
 * searchable. Messages go through `ChatMessagesService.keep` (masked) and are
 * packed by an in-process `ChatIndexSweeper`, so the vectors are real.
 *
 * Needs `make infra-up` and the embeddings provider apps/api/.env names.
 */

const WORKSPACE = '33900000-0000-4339-8339-000000000339';
type Person = { id: string; key: string; keyId: string };
type Hit = { bindingId: string; snippet: string; chunkId: string };
type Label = 'open' | 'secret' | 'guest' | 'workspace' | 'off';

describe('chat search (e2e, #339)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let graph: GraphService;
  const nonce = randomUUID().slice(0, 8);
  const word = `qorvex${nonce}`;
  const people = {} as Record<'admin' | 'alice' | 'bob' | 'gus', Person>;
  const bindings = {} as Record<Label, string>;
  let integrationId: string;

  const http = () => request(app.getHttpServer());
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });

  async function person(name: string, role: 'admin' | 'editor' | 'guest'): Promise<Person> {
    const email = `chat-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Chat ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: { userId: user.id, name: `chat e2e ${nonce}`, keyHash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 11), scope: 'write' },
    });
    return { id: user.id, key, keyId: row.id };
  }

  async function searchAs(p: Person, body: Record<string, unknown> = {}): Promise<Hit[]> {
    const res = await http()
      .post('/v1/chat/search')
      .set(as(p))
      .send({ workspaceId: WORKSPACE, query: `${word} rollout decision`, limit: 20, ...body })
      .expect(ok(200));
    return res.body.hits as Hit[];
  }
  const labels = (hits: Hit[]) =>
    [...new Set(hits.map((h) => (Object.entries(bindings).find(([, id]) => id === h.bindingId)?.[0] ?? h.bindingId) as string))].sort();

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [{ createE2eApp }, { ChatWorkerModule }, { PrismaService }, { ChatMessagesService }, { ChatIndexSweeper }, { GraphService }] =
      await Promise.all([
        import('./e2e-app.js'),
        import('../src/chat/chat-worker.module.js'),
        import('../src/prisma/prisma.service.js'),
        import('../src/chat/chat-messages.service.js'),
        import('../src/chat/chat-index.sweeper.js'),
        import('../src/graph/graph.service.js'),
      ]);
    app = await createE2eApp([ChatWorkerModule]);
    prisma = app.get(PrismaService);
    graph = app.get(GraphService);
    await graph.ensureSchema(Number(process.env.EMBEDDINGS_DIM ?? 1024));

    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Chat search e2e (#339)' } });
    people.admin = await person('admin', 'admin');
    people.alice = await person('alice', 'editor');
    people.bob = await person('bob', 'editor');
    people.gus = await person('gus', 'guest');

    const project = async (name: string) => (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `${name} ${nonce}` } })).id;
    const [open, secret, guested] = [await project('Open'), await project('Secret'), await project('Guested')];
    const access = (id: string, restricted: boolean, grantee: Person) =>
      http()
        .put(`/v1/projects/${id}/access`)
        .set(as(people.admin))
        .send({ restricted, grants: [{ subjectType: 'user', subjectId: grantee.id, level: 'view' }] })
        .expect(ok(200));
    await access(secret, true, people.alice);
    await access(guested, false, people.gus);

    integrationId = (await prisma.chatIntegration.create({ data: { workspaceId: WORKSPACE, kind: 'mattermost', name: `chat e2e ${nonce}` } })).id;
    const projects: Record<Label, string | null> = { open, secret, guest: guested, workspace: null, off: open };
    const store = app.get(ChatMessagesService);
    const sent = new Date(Date.now() - 2 * 60 * 60_000);
    for (const [label, projectId] of Object.entries(projects) as Array<[Label, string | null]>) {
      const binding = await prisma.chatChannelBinding.create({
        data: { integrationId, workspaceId: WORKSPACE, externalChatId: `ch-${label}-${nonce}`, title: `#${label}`, projectId, searchableAt: new Date() },
      });
      bindings[label] = binding.id;
      for (const [i, text] of [`The ${word} rollout decision for ${label}: ship Tuesdays, mail ops@example.com`, `agreed for ${label}`].entries()) {
        await store.keep(binding, {
          externalUserId: `U${i}`,
          externalUserName: null,
          chatId: binding.externalChatId,
          chatTitle: null,
          isDm: false,
          messageId: `${label}-${i}`,
          text,
          mentioned: false,
          replyToBotMessageId: null,
          threadId: `root-${label}`,
          command: null,
          action: null,
          at: new Date(sent.getTime() + i * 60_000),
        });
      }
    }
    // Indexed, then switched off: kept rows of a binding that is not searchable never show.
    await app.get(ChatIndexSweeper).sweep();
    await prisma.chatChannelBinding.update({ where: { id: bindings.off }, data: { searchableAt: null } });
  }, 120_000);

  afterAll(async () => {
    if (!app) return;
    const chunkIds = (await prisma.chatChunk.findMany({ where: { workspaceId: WORKSPACE }, select: { id: true } })).map((c) => c.id);
    if (integrationId) await prisma.chatIntegration.delete({ where: { id: integrationId } });
    await graph.deleteChatChunks(WORKSPACE, chunkIds);
    await prisma.apiKey.deleteMany({ where: { id: { in: Object.values(people).map((p) => p.keyId) } } });
    await app.close();
  });

  it('indexed every searchable binding', async () => {
    expect(await prisma.chatChunk.count({ where: { workspaceId: WORKSPACE } })).toBe(5);
  });

  it('an admin finds every searchable group, and never one switched off', async () => {
    expect(labels(await searchAs(people.admin))).toEqual(['guest', 'open', 'secret', 'workspace']);
  });

  it('a restricted project’s chat is found by its grantee and hidden from a member without a grant', async () => {
    expect(labels(await searchAs(people.alice))).toEqual(['guest', 'open', 'secret', 'workspace']);
    expect(labels(await searchAs(people.bob))).toEqual(['guest', 'open', 'workspace']);
  });

  it('a guest finds only the chat of the project they were granted, never a project-less group', async () => {
    expect(labels(await searchAs(people.gus))).toEqual(['guest']);
  });

  it('filters narrow, never widen: asking for a hidden binding by id returns nothing', async () => {
    expect(await searchAs(people.bob, { bindingIds: [bindings.secret] })).toEqual([]);
    expect(labels(await searchAs(people.bob, { bindingIds: [bindings.open] }))).toEqual(['open']);
  });

  it('availability reads through the same ACL: a guest with no grant sees no Chat tab', async () => {
    const readable = async (p: Person) =>
      (await http().get('/v1/chat/search').query({ workspaceId: WORKSPACE }).set(as(p)).expect(ok(200))).body.readable as boolean;
    expect(await readable(people.bob)).toBe(true);
    expect(await readable(people.gus)).toBe(true);
    const nan = await person('nan', 'guest');
    try {
      expect(await readable(nan)).toBe(false);
    } finally {
      await prisma.apiKey.delete({ where: { id: nan.keyId } });
    }
  });

  it('snippets are masked and name no one', async () => {
    const [hit] = await searchAs(people.admin, { bindingIds: [bindings.open] });
    expect(hit.snippet).toContain('[EMAIL_1]');
    expect(hit.snippet).not.toContain('ops@example.com');
    expect(hit.snippet).toMatch(/^author-1: /);
  });

  it('a person outside the workspace is refused', async () => {
    const stranger = await prisma.user.upsert({
      where: { email: 'chat-e2e-stranger@example.test' },
      update: {},
      create: { email: 'chat-e2e-stranger@example.test', displayName: 'Stranger', isAdmin: false, emailVerifiedAt: new Date() },
    });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: { userId: stranger.id, name: `chat e2e ${nonce}`, keyHash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 11), scope: 'write' },
    });
    try {
      await http().post('/v1/chat/search').set({ Authorization: `Bearer ${key}` }).send({ workspaceId: WORKSPACE, query: word }).expect(ok(403));
    } finally {
      await prisma.apiKey.delete({ where: { id: row.id } });
    }
  });
});
