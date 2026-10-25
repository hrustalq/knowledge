import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { GraphService } from '../src/graph/graph.service.js';
import type { EmbeddingProvider } from '../src/embedding/embedding.provider.js';

/**
 * #475 acceptance, end to end against live infra: the community prior, as a
 * non-admin reader. A community tree over an open page and a restricted one
 * boosts the open page for the reader the restriction admits, and gives the
 * reader it excludes nothing — not from the leaf, not from its ancestor, and
 * no `communityPath` naming either.
 *
 * Communities are seeded through `GraphService.replaceCommunities` with real
 * embeddings, so no model writes a summary. Forces `AUTH_MODE=api-key` with
 * its own people, as page-permissions.e2e-spec.ts does: the dev principal
 * bypasses every restriction. Needs `make infra-up` and the embeddings
 * provider apps/api/.env names.
 */

const WORKSPACE = '47500000-0000-4475-8475-000000000475';
const INDEX_TIMEOUT_MS = 120_000;

type Person = { id: string; key: string; keyId: string };
type Hit = { documentId: string; score: number; communityPath?: string[] };

describe('community prior under page restrictions (e2e, #475)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let graph: GraphService;
  const nonce = randomUUID().slice(0, 8);
  const word = `quorvex${nonce}`;
  const people = {} as Record<'admin' | 'alice' | 'bob', Person>;
  const ids = {} as Record<'open' | 'other' | 'secret', string>;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });

  async function person(name: string, role: 'admin' | 'editor'): Promise<Person> {
    const email = `layers-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Layers ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role },
      create: { workspaceId: WORKSPACE, userId: user.id, role },
    });
    const key = `kn_${randomBytes(24).toString('hex')}`;
    const row = await prisma.apiKey.create({
      data: { userId: user.id, name: `layers e2e ${nonce}`, keyHash: createHash('sha256').update(key).digest('hex'), prefix: key.slice(0, 11), scope: 'write' },
    });
    return { id: user.id, key, keyId: row.id };
  }

  async function createPage(key: keyof typeof ids, text: string): Promise<string> {
    const title = `${key} ${word}`;
    const res = await http()
      .post('/v1/documents')
      .set(as(people.admin))
      .send({ workspaceId: WORKSPACE, projectId, title, visibility: 'workspace', content: { mode: 'inline', format: 'markdown', text: `# ${title}\n\n${text}\n` } })
      .expect(ok(201));
    ids[key] = res.body.documentId;
    return res.body.revisionId as string;
  }

  async function waitIndexed(revisionId: string): Promise<void> {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
      const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { status: true } });
      if (rev.status === 'indexed') return;
      if (rev.status === 'failed') throw new Error(`revision ${revisionId} failed to index`);
      if (Date.now() > deadline) throw new Error(`revision ${revisionId} still ${rev.status} after ${INDEX_TIMEOUT_MS}ms`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function prior(weight: number | null): Promise<void> {
    await prisma.knowledgeHealthSettings.upsert({
      where: { workspaceId: WORKSPACE },
      update: { communityPriorWeight: weight, communityPriorFloor: weight === null ? null : 0.2 },
      create: { workspaceId: WORKSPACE, communityPriorWeight: weight, communityPriorFloor: weight === null ? null : 0.2 },
    });
  }

  async function search(p: Person): Promise<Hit[]> {
    const res = await http()
      .post('/v1/search')
      .set(as(p))
      .send({ workspaceId: WORKSPACE, query: `invoice reconciliation ${word}`, mode: 'semantic', limit: 10, groupBy: 'page', filters: { projectIds: [projectId] } })
      .expect(ok(200));
    return res.body.results as Hit[];
  }
  const byId = (hits: Hit[]) => new Map(hits.map((h) => [h.documentId, h]));

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [{ createE2eApp }, { IngestionWorkerModule }, { PrismaService }, { GraphService }, { EMBEDDING_PROVIDER }] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/ingestion/ingestion-worker.module.js'),
      import('../src/prisma/prisma.service.js'),
      import('../src/graph/graph.service.js'),
      import('../src/embedding/embedding.provider.js'),
    ]);
    app = await createE2eApp([IngestionWorkerModule]);
    prisma = app.get(PrismaService);
    graph = app.get(GraphService);

    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Graph layers e2e (#475)' } });
    people.admin = await person('admin', 'admin');
    people.alice = await person('alice', 'editor');
    people.bob = await person('bob', 'editor');
    projectId = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Layers e2e ${nonce}` } })).id;

    const revisions = [
      await createPage('open', `How invoice reconciliation runs at month end, and who signs the ${word} ledger.`),
      await createPage('other', `Invoice reconciliation notes for the ${word} audit: the same steps, written for auditors.`),
      await createPage('secret', `The restricted ${word} reconciliation ledger and its owners.`),
    ];
    await Promise.all(revisions.map(waitIndexed));
    await http()
      .put(`/v1/documents/${ids.secret}/access`)
      .set(as(people.admin))
      .send({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.alice.id, level: 'view' }] })
      .expect(ok(200));

    // A leaf over the open page and the secret one, under a root over the same two.
    const embed = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
    const summary = `Invoice reconciliation ${word}`;
    const embedding = await embed.embed(summary);
    const members = [ids.open, ids.secret].sort();
    await graph.replaceCommunities(
      WORKSPACE,
      [
        { communityId: `1:${members[0]}`, level: 1, parentId: null, title: 'Finance', summary, members, embedding },
        { communityId: `0:${members[0]}`, level: 0, parentId: `1:${members[0]}`, title: 'Reconciliation', summary, members, embedding },
      ],
      `e2e-${nonce}`,
    );
  }, INDEX_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (!app) return;
    await graph.replaceCommunities(WORKSPACE, [], '');
    await prior(null);
    for (const id of Object.values(ids)) await http().post(`/v1/documents/${id}/archive`).set(as(people.admin)).send({});
    await prisma.apiKey.deleteMany({ where: { id: { in: Object.values(people).map((p) => p.keyId) } } });
    await app.close();
  });

  it('boosts the open page for a reader who may open every page of the community', async () => {
    await prior(0);
    const off = byId(await search(people.alice));
    await prior(1);
    const on = byId(await search(people.alice));
    expect(on.get(ids.open)!.communityPath).toEqual(['Finance', 'Reconciliation']);
    expect(on.get(ids.open)!.score).toBeGreaterThan(off.get(ids.open)!.score);
    expect(on.get(ids.other)!.score).toBeCloseTo(off.get(ids.other)!.score, 4);
  });

  it('gives a reader who cannot open one of its pages nothing from it or its ancestor', async () => {
    await prior(0);
    const off = await search(people.bob);
    await prior(1);
    const on = await search(people.bob);
    expect(on.map((h) => [h.documentId, h.score])).toEqual(off.map((h) => [h.documentId, h.score]));
    expect(on.some((h) => h.documentId === ids.secret)).toBe(false);
    expect(on.every((h) => !h.communityPath)).toBe(true);
    const overview = await http()
      .get('/v1/graph/communities')
      .query({ workspaceId: WORKSPACE, level: 1 })
      .set(as(people.bob))
      .expect(ok(200));
    expect(overview.body.communities).toEqual([]);
  });
});
