import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #74 phase 5 acceptance, end to end against live infra: the quality reads
 * over real rows, for real people with real API keys.
 *
 *   - the summary counts the pages in scope, scores each page by its **newest**
 *     row, and draws one history point per audit day from the corpus as it
 *     stood that evening;
 *   - a page in another workspace is a 403, and a restricted page moves no
 *     number for a reader who cannot open it — nor is it named as a
 *     near-duplicate peer;
 *   - MCP's `knowledge_get_page_quality` returns the REST payload.
 *
 * Like page-permissions.e2e-spec.ts it forces `AUTH_MODE=api-key`: the dev
 * principal would pass every check for the wrong reason. Score rows are
 * written directly with fixture dates — the auditor that writes them in
 * production is covered by quality.spec.ts. Needs `make infra-up` only: no
 * page is waited on to index. Each run makes a fresh project, archives its
 * pages and deletes its keys.
 */

const WORKSPACE = '74000000-0000-4074-8074-000000000074';
const OTHER = '74000000-0000-4074-8074-0000000000b7';
const DAY_1 = new Date('2026-01-10T12:00:00Z');
const DAY_2 = new Date('2026-01-11T12:00:00Z');

type Person = { id: string; key: string; keyId: string };

describe('docs quality reads (e2e, #74)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const nonce = randomUUID().slice(0, 8);
  const people = {} as Record<'admin' | 'eve', Person>;
  let projectId: string;
  /** X: scored twice; Y: scored once, breaks a rule; Z: never scored; R: restricted to the admin; F: another workspace. */
  const ids = {} as Record<'X' | 'Y' | 'Z' | 'R' | 'F', string>;
  const heads = {} as Record<'X' | 'Y' | 'R', string>;

  const http = () => request(app.getHttpServer());
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };
  const as = (p: Person) => ({ Authorization: `Bearer ${p.key}` });

  async function person(name: string, role: 'admin' | 'editor'): Promise<Person> {
    const email = `quality-e2e-${name}@example.test`;
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: `Quality ${name}`, isAdmin: false, emailVerifiedAt: new Date() },
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
        name: `quality e2e ${nonce}`,
        keyHash: createHash('sha256').update(key).digest('hex'),
        prefix: key.slice(0, 11),
        scope: 'write',
      },
    });
    return { id: user.id, key, keyId: row.id };
  }

  async function createPage(workspaceId: string, project: string, title: string): Promise<{ documentId: string; revisionId: string }> {
    const res = await http()
      .post('/v1/documents')
      .set(as(people.admin))
      .send({
        workspaceId,
        projectId: project,
        title,
        content: { mode: 'inline', format: 'markdown', text: `# ${title}\n\nThe ${nonce} procedure, step by step.\n` },
      })
      .expect(ok(201));
    return res.body as { documentId: string; revisionId: string };
  }

  function score(key: 'X' | 'Y' | 'R', overall: number, createdAt: Date, extra: { issues?: unknown[]; duplicates?: unknown[] } = {}) {
    return {
      workspaceId: WORKSPACE,
      projectId,
      documentId: ids[key],
      revisionId: heads[key],
      rubricVersion: 1,
      overall,
      dimensions: { clarity: overall, completeness: overall, links: 100, ownership: 0, duplication: null, style: null },
      issues: (extra.issues ?? []) as never,
      duplicates: (extra.duplicates ?? []) as never,
      createdAt,
    };
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [{ createE2eApp }, { PrismaService }] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/prisma/prisma.service.js'),
    ]);
    app = await createE2eApp();
    prisma = app.get(PrismaService);

    for (const [id, name] of [
      [WORKSPACE, 'Quality e2e (#74)'],
      [OTHER, 'Quality e2e, elsewhere (#74)'],
    ]) {
      await prisma.workspace.upsert({ where: { id }, update: {}, create: { id, name } });
    }
    people.admin = await person('admin', 'admin');
    people.eve = await person('eve', 'editor');
    projectId = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Quality e2e ${nonce}` } })).id;

    for (const key of ['X', 'Y', 'Z', 'R'] as const) {
      const page = await createPage(WORKSPACE, projectId, `Quality ${key} ${nonce}`);
      ids[key] = page.documentId;
      if (key !== 'Z') heads[key] = page.revisionId;
    }
    await http()
      .put(`/v1/documents/${ids.R}/access`)
      .set(as(people.admin))
      .send({ restricted: true, grants: [{ subjectType: 'user', subjectId: people.admin.id, level: 'view' }] })
      .expect(ok(200));

    // A page in a workspace nobody here belongs to — membership lent to the
    // admin for the create, then taken back.
    await prisma.workspaceMember.create({ data: { workspaceId: OTHER, userId: people.admin.id, role: 'admin' } });
    const otherProject = await prisma.project.create({ data: { workspaceId: OTHER, name: `Quality e2e ${nonce}` } });
    ids.F = (await createPage(OTHER, otherProject.id, `Quality F ${nonce}`)).documentId;
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: OTHER, userId: people.admin.id } } });

    await prisma.documentQualityScore.createMany({
      data: [
        score('X', 40, DAY_1),
        score('X', 80, DAY_2, {
          duplicates: [{ documentId: ids.R, similarity: 0.95 }],
          issues: [{ dimension: 'duplication', severity: 'warning', message: 'Near-duplicate of a restricted page', documentId: ids.R }],
        }),
        score('Y', 30, DAY_2, {
          issues: [{ dimension: 'style', severity: 'error', message: 'Say select', ruleId: 'ui-verbs', quote: 'click on' }],
        }),
        score('R', 10, DAY_2),
      ],
    });
  }, 60_000);

  afterAll(async () => {
    if (!app) return;
    for (const key of ['X', 'Y', 'Z', 'R'] as const) {
      if (ids[key]) await http().post(`/v1/documents/${ids[key]}/archive`).set(as(people.admin)).send({});
    }
    if (ids.F) await prisma.document.update({ where: { id: ids.F }, data: { archivedAt: new Date() } });
    const keyIds = Object.values(people).map((p) => p.keyId);
    if (keyIds.length) await prisma.apiKey.deleteMany({ where: { id: { in: keyIds } } });
    await app.close();
  });

  it('summarises each page by its newest score, with a history point per audit day', async () => {
    const res = await http()
      .get('/v1/quality/summary')
      .query({ workspaceId: WORKSPACE, projectId })
      .set(as(people.eve))
      .expect(ok(200));
    // R is restricted: not a page eve can count, and its 10 moves nothing.
    expect(res.body).toMatchObject({ totalPages: 3, scoredPages: 2, average: 55, distribution: [0, 1, 0, 0, 1] });
    expect(res.body.dimensions.links).toEqual({ mean: 100, measured: 2 });
    expect(res.body.dimensions.duplication).toEqual({ mean: null, measured: 0 });
    // Day 1: X alone (40). Day 2: X's newer 80 replaces its 40, and Y joins.
    expect(res.body.history).toEqual([
      { date: '2026-01-10', overall: 40 },
      { date: '2026-01-11', overall: 55 },
    ]);
    expect(res.body.worst.map((r: { documentId: string }) => r.documentId)).toEqual([ids.Y, ids.X]);
    expect(res.body.rules).toEqual([{ ruleId: 'ui-verbs', text: null, count: 1, pages: 1 }]);
  });

  it('lists the scored pages worst first, and counts the restricted one only for its reader', async () => {
    const eve = await http().get('/v1/quality/documents').query({ workspaceId: WORKSPACE, projectId }).set(as(people.eve)).expect(ok(200));
    expect(eve.body.rows.map((r: { documentId: string; overall: number }) => [r.documentId, r.overall])).toEqual([
      [ids.Y, 30],
      [ids.X, 80],
    ]);
    expect(eve.body.total).toBe(2);
    const admin = await http().get('/v1/quality/documents').query({ workspaceId: WORKSPACE, projectId }).set(as(people.admin)).expect(ok(200));
    expect(admin.body.rows[0]).toMatchObject({ documentId: ids.R, overall: 10 });
  });

  it("returns a page's newest score and history, naming only the peers the reader may open", async () => {
    const eve = await http().get(`/v1/documents/${ids.X}/quality`).set(as(people.eve)).expect(ok(200));
    expect(eve.body.score).toMatchObject({ documentId: ids.X, overall: 80, duplicates: [], issues: [] });
    expect(eve.body.peers).toEqual([]);
    expect(eve.body.stale).toBe(false);
    expect(eve.body.history).toEqual([
      { date: '2026-01-10', overall: 40 },
      { date: '2026-01-11', overall: 80 },
    ]);
    expect(JSON.stringify(eve.body)).not.toContain(ids.R);

    const admin = await http().get(`/v1/documents/${ids.X}/quality`).set(as(people.admin)).expect(ok(200));
    expect(admin.body.peers).toEqual([{ documentId: ids.R, similarity: 0.95, title: `Quality R ${nonce}` }]);
  });

  it('is null before the first audit, and refuses a page of another workspace', async () => {
    const unscored = await http().get(`/v1/documents/${ids.Z}/quality`).set(as(people.eve)).expect(ok(200));
    expect(unscored.body).toEqual({ documentId: ids.Z, score: null, peers: [], stale: false, history: [], lowThreshold: expect.any(Number) });
    await http().get(`/v1/documents/${ids.F}/quality`).set(as(people.eve)).expect(ok(403));
    await http().get('/v1/quality/summary').query({ workspaceId: OTHER }).set(as(people.eve)).expect(ok(403));
  });

  it('answers knowledge_get_page_quality with the REST payload', async () => {
    const rest = await http().get(`/v1/documents/${ids.Y}/quality`).set(as(people.eve)).expect(ok(200));
    const res = await http()
      .post('/v1/mcp')
      .set({ ...as(people.eve), Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'knowledge_get_page_quality', arguments: { documentId: ids.Y } } })
      .expect(ok(200));
    const result = res.body.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual(rest.body);
  });
});
