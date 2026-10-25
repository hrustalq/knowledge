import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #79 at the HTTP edge, for what the other analytics e2e specs reach only
 * through the recorder: which reads count as a view, the MCP view and its
 * tool-call row, the REST search row and its `searchId`, DNT / GPC, and who
 * may read which analytics route.
 *
 * Like analytics-flow, it forces `AUTH_MODE=api-key`, uses a fixed workspace
 * of its own, and needs `make infra-up` plus the embeddings provider
 * apps/api/.env names.
 */

const WORKSPACE = '79000000-0000-4079-8079-0000000000ac';
const INDEX_TIMEOUT_MS = 120_000;

async function until<T>(
  read: () => Promise<T | null | undefined>,
  what: string,
  ms = 10_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
// Recording is fire-and-forget: long enough for a stray second row to land.
const settle = () => new Promise((r) => setTimeout(r, 1500));

describe('usage analytics at the HTTP edge (e2e, #79)', () => {
  const nonce = randomBytes(4).toString('hex');
  const word = `wombat${nonce}`;
  let app: INestApplication;
  let prisma: PrismaService;
  const session: Record<'admin' | 'editor' | 'viewer', string> = {
    admin: '',
    editor: '',
    viewer: '',
  };
  let key: string;
  let keyId: string;
  let documentId: string;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const as = (who: keyof typeof session) => ({
    Authorization: `Bearer ${session[who]}`,
  });

  async function mcp(name: string, args: Record<string, unknown>) {
    const res = await http()
      .post('/v1/mcp')
      .set({
        Authorization: `Bearer ${key}`,
        Accept: 'application/json, text/event-stream',
      })
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      });
    expect(res.status).toBe(200);
    return res.body.result as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  }

  beforeAll(async () => {
    process.env.AUTH_MODE = 'api-key';
    const [
      { createE2eApp },
      { IngestionWorkerModule },
      { PrismaService },
      { SessionsService },
    ] = await Promise.all([
      import('./e2e-app.js'),
      import('../src/ingestion/ingestion-worker.module.js'),
      import('../src/prisma/prisma.service.js'),
      import('../src/auth/sessions.service.js'),
    ]);
    app = await createE2eApp([IngestionWorkerModule]);
    prisma = app.get(PrismaService);
    await prisma.workspace.upsert({
      where: { id: WORKSPACE },
      update: {},
      create: { id: WORKSPACE, name: 'Analytics AC (#79)' },
    });

    let adminId = '';
    for (const role of ['admin', 'editor', 'viewer'] as const) {
      const email = `ac79-${role}@example.test`;
      const user = await prisma.user.upsert({
        where: { email },
        update: { isAdmin: false, emailVerifiedAt: new Date() },
        create: {
          email,
          displayName: `AC79 ${role}`,
          isAdmin: false,
          emailVerifiedAt: new Date(),
        },
      });
      await prisma.workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id },
        },
        update: { role },
        create: { workspaceId: WORKSPACE, userId: user.id, role },
      });
      session[role] = (await app.get(SessionsService).create(user.id)).token;
      if (role === 'admin') adminId = user.id;
    }
    key = `kn_${randomBytes(24).toString('hex')}`;
    keyId = (
      await prisma.apiKey.create({
        data: {
          userId: adminId,
          name: `ac79 ${nonce}`,
          keyHash: createHash('sha256').update(key).digest('hex'),
          prefix: key.slice(0, 11),
          scope: 'write',
        },
      })
    ).id;

    projectId = (
      await prisma.project.create({
        data: { workspaceId: WORKSPACE, name: `AC79 ${nonce}` },
      })
    ).id;
    const created = await http()
      .post('/v1/documents')
      .set(as('admin'))
      .send({
        workspaceId: WORKSPACE,
        visibility: 'workspace',
        projectId,
        title: `Onboarding ${word}`,
        content: {
          mode: 'inline',
          format: 'markdown',
          text: `# Onboarding ${word}\n\nHow a new ${word} hire gets access.\n`,
        },
      });
    expect(created.status).toBe(201);
    documentId = created.body.documentId;
    const revisionId = created.body.revisionId as string;
    await until(
      async () => {
        const rev = await prisma.documentRevision.findUniqueOrThrow({
          where: { id: revisionId },
          select: { status: true },
        });
        if (rev.status === 'failed') throw new Error('index failed');
        return rev.status === 'indexed';
      },
      'the page to index',
      INDEX_TIMEOUT_MS,
    );
  }, INDEX_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (!app) return;
    if (documentId)
      await http()
        .post(`/v1/documents/${documentId}/archive`)
        .set(as('admin'))
        .send({});
    await prisma.pageView.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.searchQuery.deleteMany({ where: { workspaceId: WORKSPACE } });
    await prisma.mcpToolCall.deleteMany({
      where: { OR: [{ workspaceId: WORKSPACE }, { apiKeyId: keyId }] },
    });
    if (keyId) await prisma.apiKey.deleteMany({ where: { id: keyId } });
    await app.close();
  });

  it('a session GET /content records no view; a kn_ key records one api view', async () => {
    await prisma.pageView.deleteMany({ where: { documentId } });
    expect(
      (await http().get(`/v1/documents/${documentId}/content`).set(as('admin')))
        .status,
    ).toBe(200);
    await settle();
    expect(await prisma.pageView.count({ where: { documentId } })).toBe(0);

    expect(
      (
        await http()
          .get(`/v1/documents/${documentId}/content`)
          .set({ Authorization: `Bearer ${key}` })
      ).status,
    ).toBe(200);
    const rows = await until(async () => {
      const r = await prisma.pageView.findMany({ where: { documentId } });
      return r.length ? r : null;
    }, 'an api view');
    await settle();
    const all = await prisma.pageView.findMany({ where: { documentId } });
    expect(all).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'api',
      apiKeyId: keyId,
      workspaceId: WORKSPACE,
      projectId,
    });
  });

  it('knowledge_get_document_content records an mcp view with the key, and one ok tool-call row', async () => {
    await prisma.pageView.deleteMany({ where: { documentId } });
    await prisma.mcpToolCall.deleteMany({ where: { apiKeyId: keyId } });
    const out = await mcp('knowledge_get_document_content', { documentId });
    expect(out.isError).toBeFalsy();
    const view = await until(
      () => prisma.pageView.findFirst({ where: { documentId } }),
      'an mcp view',
    );
    expect(view).toMatchObject({ channel: 'mcp', apiKeyId: keyId });
    const call = await until(
      () =>
        prisma.mcpToolCall.findFirst({
          where: { apiKeyId: keyId, tool: 'knowledge_get_document_content' },
        }),
      'a tool call',
    );
    expect(call).toMatchObject({ ok: true, workspaceId: WORKSPACE });
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    await settle();
    expect(await prisma.mcpToolCall.count({ where: { apiKeyId: keyId } })).toBe(
      1,
    );
  });

  it('a failing MCP tool call records ok=false with an error code', async () => {
    await mcp('knowledge_get_document', {
      documentId: '00000000-0000-4000-8000-000000000000',
    });
    const call = await until(
      () =>
        prisma.mcpToolCall.findFirst({
          where: { apiKeyId: keyId, tool: 'knowledge_get_document' },
        }),
      'a failed call',
    );
    expect(call.ok).toBe(false);
    expect(call.errorCode).toBeTruthy();
  });

  it('REST search with a kn_ key returns searchId and files one api row with count and top ids', async () => {
    const res = await http()
      .post('/v1/search')
      .set({ Authorization: `Bearer ${key}` })
      .send({
        workspaceId: WORKSPACE,
        query: word,
        mode: 'keyword',
        limit: 10,
      });
    expect(res.status).toBe(200);
    expect(res.body.searchId).toMatch(/^[0-9a-f-]{36}$/);
    const row = await until(
      () => prisma.searchQuery.findUnique({ where: { id: res.body.searchId } }),
      'the search row',
    );
    const ids = (res.body.results as Array<{ documentId: string }>).map(
      (r) => r.documentId,
    );
    expect(row).toMatchObject({
      channel: 'api',
      apiKeyId: keyId,
      resultCount: ids.length,
      workspaceId: WORKSPACE,
    });
    expect(row.resultDocIds).toEqual([...new Set(ids)].slice(0, 10));
    expect(ids).toContain(documentId);
  });

  it('with DNT: 1 or Sec-GPC: 1 a search keeps no reader key', async () => {
    for (const header of [{ DNT: '1' }, { 'Sec-GPC': '1' }]) {
      const res = await http()
        .post('/v1/search')
        .set({ ...as('admin'), ...header })
        .send({ workspaceId: WORKSPACE, query: word, mode: 'keyword' });
      expect(res.status).toBe(200);
      const row = await until(
        () =>
          prisma.searchQuery.findUnique({ where: { id: res.body.searchId } }),
        'the dnt row',
      );
      expect(row.readerKey).toBeNull();
      expect(row.channel).toBe('web');
    }
    const res = await http()
      .post('/v1/search')
      .set(as('admin'))
      .send({ workspaceId: WORKSPACE, query: word, mode: 'keyword' });
    const row = await until(
      () => prisma.searchQuery.findUnique({ where: { id: res.body.searchId } }),
      'the tracked row',
    );
    expect(row.readerKey).toBeTruthy();
  });

  it('only admins reach /v1/analytics/*; viewers read insights; editors read project analytics', async () => {
    const routes = [
      'overview',
      'pages',
      'search',
      'agents',
      'settings',
      'export.csv',
    ].map(
      (r) => `/v1/analytics/${r}?workspaceId=${WORKSPACE}&report=pages-top`,
    );
    for (const url of routes) {
      for (const who of ['viewer', 'editor'] as const)
        expect([url, who, (await http().get(url).set(as(who))).status]).toEqual(
          [url, who, 403],
        );
      const admin = await http().get(url).set(as('admin'));
      expect([url, admin.status]).toEqual([url, 200]);
    }

    const insights = await http()
      .get(`/v1/documents/${documentId}/insights`)
      .set(as('viewer'));
    expect(insights.status).toBe(200);
    for (const k of [
      'views',
      'uniqueReaders',
      'medianReadMs',
      'lastHumanViewAt',
      'series',
    ])
      expect(Object.keys(insights.body)).toContain(k);

    expect(
      (
        await http()
          .get(`/v1/projects/${projectId}/analytics`)
          .set(as('viewer'))
      ).status,
    ).toBe(403);
    const project = await http()
      .get(`/v1/projects/${projectId}/analytics`)
      .set(as('editor'));
    expect(project.status).toBe(200);
    // No query text or identities in what a viewer or editor reads.
    for (const body of [
      JSON.stringify(insights.body),
      JSON.stringify(project.body),
    ]) {
      expect(body).not.toMatch(/readerKey|userId|email|queryText/);
    }
  });
});
