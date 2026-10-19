import type { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { AnalyticsQueryService } from '../src/analytics/analytics-query.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #79 phase 5: the whole recording loop, end to end against live infra. A
 * person signed in to the app (a `ks_` session) opens a page, searches for
 * something that is not there, and opens a result; an agent searches over
 * `/v1/mcp` with a `kn_` key. The rollups then read back a zero-result query,
 * a counted click-through, and the agent's search under its own channel.
 *
 * It forces `AUTH_MODE=api-key` (the dev principal has no key, so it can be
 * neither a session nor an agent) and uses a fixed workspace of its own.
 * Needs `make infra-up`, the embeddings provider apps/api/.env names and, when
 * that file sets FULLTEXT_PROVIDER=opensearch, `make infra-up-opensearch`.
 */

const WORKSPACE = '79000000-0000-4079-8079-000000000079';
const INDEX_TIMEOUT_MS = 120_000;

async function until<T>(read: () => Promise<T | null | undefined>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('usage analytics, recorded end to end (e2e, #79)', () => {
  const nonce = randomBytes(4).toString('hex');
  // One word only this run's page holds, and one no page holds.
  const word = `quokka${nonce}`;
  const missing = `zyzzyva${nonce}`;
  let app: INestApplication;
  let prisma: PrismaService;
  let query: AnalyticsQueryService;
  let session: string;
  let key: string;
  let keyId: string;
  let documentId: string;

  const http = () => request(app.getHttpServer());
  const ok = (code: number) => (res: request.Response) => {
    if (res.status !== code) throw new Error(`${res.status} (wanted ${code}): ${JSON.stringify(res.body)}`);
  };

  async function mcp(name: string, args: Record<string, unknown>) {
    const res = await http()
      .post('/v1/mcp')
      .set({ Authorization: `Bearer ${key}`, Accept: 'application/json, text/event-stream' })
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      .expect(ok(200));
    return res.body.result as { isError?: boolean; content: Array<{ text: string }> };
  }

  // Keyword mode: semantic search always finds a nearest neighbour, so only
  // the full-text leg can come back empty.
  const webSearch = (q: string) =>
    http()
      .post('/v1/search')
      .set({ Authorization: `Bearer ${session}` })
      .send({ workspaceId: WORKSPACE, query: q, mode: 'keyword', limit: 10 })
      .expect(ok(200))
      .then((r) => r.body as { searchId: string; results: Array<{ documentId: string }> });

  beforeAll(async () => {
    // Before the app module is imported: ConfigModule validates the env once.
    process.env.AUTH_MODE = 'api-key';
    const [{ createE2eApp }, { IngestionWorkerModule }, { PrismaService }, { SessionsService }, { AnalyticsQueryService }] =
      await Promise.all([
        import('./e2e-app.js'),
        import('../src/ingestion/ingestion-worker.module.js'),
        import('../src/prisma/prisma.service.js'),
        import('../src/auth/sessions.service.js'),
        import('../src/analytics/analytics-query.service.js'),
      ]);
    app = await createE2eApp([IngestionWorkerModule]);
    prisma = app.get(PrismaService);
    query = app.get(AnalyticsQueryService);

    await prisma.workspace.upsert({ where: { id: WORKSPACE }, update: {}, create: { id: WORKSPACE, name: 'Analytics e2e (#79)' } });
    const email = 'analytics-e2e@example.test';
    // A workspace admin, not a platform admin: the search-gaps tool must pass on the role.
    const user = await prisma.user.upsert({
      where: { email },
      update: { isAdmin: false, emailVerifiedAt: new Date() },
      create: { email, displayName: 'Analytics e2e', isAdmin: false, emailVerifiedAt: new Date() },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: WORKSPACE, userId: user.id } },
      update: { role: 'admin' },
      create: { workspaceId: WORKSPACE, userId: user.id, role: 'admin' },
    });
    session = (await app.get(SessionsService).create(user.id)).token;
    key = `kn_${randomBytes(24).toString('hex')}`;
    keyId = (
      await prisma.apiKey.create({
        data: {
          userId: user.id,
          name: `analytics e2e ${nonce}`,
          keyHash: createHash('sha256').update(key).digest('hex'),
          prefix: key.slice(0, 11),
          scope: 'write',
        },
      })
    ).id;

    const projectId = (await prisma.project.create({ data: { workspaceId: WORKSPACE, name: `Analytics e2e ${nonce}` } })).id;
    const created = await http()
      .post('/v1/documents')
      .set({ Authorization: `Bearer ${session}` })
      .send({
        workspaceId: WORKSPACE,
        projectId,
        title: `Release checklist ${word}`,
        content: { mode: 'inline', format: 'markdown', text: `# Release checklist ${word}\n\nWho signs the ${word} release, and where its record lives.\n` },
      })
      .expect(ok(201));
    documentId = created.body.documentId;
    const revisionId = created.body.revisionId as string;
    await until(
      async () => {
        const rev = await prisma.documentRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { status: true } });
        if (rev.status === 'failed') throw new Error(`revision ${revisionId} failed to index`);
        return rev.status === 'indexed';
      },
      'the page to index',
      INDEX_TIMEOUT_MS,
    );
  }, INDEX_TIMEOUT_MS + 60_000);

  afterAll(async () => {
    if (!app) return;
    if (documentId) await http().post(`/v1/documents/${documentId}/archive`).set({ Authorization: `Bearer ${session}` }).send({});
    const workspaceId = WORKSPACE;
    await prisma.pageView.deleteMany({ where: { workspaceId } });
    await prisma.searchQuery.deleteMany({ where: { workspaceId } });
    await prisma.mcpToolCall.deleteMany({ where: { workspaceId } });
    if (keyId) await prisma.apiKey.deleteMany({ where: { id: keyId } });
    await app.close();
  });

  it('records a web search that found nothing, under the zero-result list', async () => {
    const res = await webSearch(missing);
    expect(res.results).toHaveLength(0);
    const row = await until(() => prisma.searchQuery.findUnique({ where: { id: res.searchId } }), 'the search row');
    expect(row).toMatchObject({ channel: 'web', resultCount: 0, apiKeyId: null, queryText: missing });

    const gaps = await query.searchGaps(WORKSPACE, 1);
    expect(gaps.zeroResult.map((g) => g.queryText)).toContain(missing);
  });

  it('counts a click on a result as click-through, and the view carries its rank', async () => {
    const res = await webSearch(word);
    const rank = res.results.findIndex((r) => r.documentId === documentId) + 1;
    expect(rank).toBeGreaterThan(0);
    await until(() => prisma.searchQuery.findUnique({ where: { id: res.searchId } }), 'the search row');

    const viewId = randomUUID();
    await http()
      .post(`/v1/documents/${documentId}/views`)
      .set({ Authorization: `Bearer ${session}` })
      .send({ viewId, searchId: res.searchId, searchRank: rank })
      .expect(ok(204));
    expect(await prisma.pageView.findUnique({ where: { id: viewId } })).toMatchObject({
      channel: 'web',
      documentId,
      searchId: res.searchId,
      searchRank: rank,
    });

    const { top } = await query.search(WORKSPACE, 1, 'human');
    const group = top.find((g) => g.queryText === word);
    expect(group).toMatchObject({ searches: 1, clickThrough: 1, meanClickedRank: rank });
  });

  it('counts an MCP search over a kn_ key as agent traffic, with its tool call', async () => {
    const before = new Date();
    const result = await mcp('knowledge_search', { workspaceId: WORKSPACE, query: word, mode: 'keyword' });
    expect(result.isError).toBeFalsy();

    const row = await until(
      () => prisma.searchQuery.findFirst({ where: { workspaceId: WORKSPACE, channel: 'mcp', createdAt: { gte: before } } }),
      'the MCP search row',
    );
    expect(row).toMatchObject({ apiKeyId: keyId, queryText: word });
    expect(row.resultCount).toBeGreaterThan(0);
    const call = await until(
      () => prisma.mcpToolCall.findFirst({ where: { workspaceId: WORKSPACE, tool: 'knowledge_search', createdAt: { gte: before } } }),
      'the tool-call row',
    );
    expect(call).toMatchObject({ ok: true, apiKeyId: keyId });

    const agents = await query.search(WORKSPACE, 1, 'agent');
    expect(agents.top.map((g) => g.queryText)).toEqual([word]);
  });

  it('hands an admin key the search gaps, wrapped as untrusted data', async () => {
    const result = await mcp('knowledge_list_search_gaps', { workspaceId: WORKSPACE, days: 1 });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/^<search-queries tool="knowledge_list_search_gaps">/);
    expect(text).toContain(missing);

    const insights = await mcp('knowledge_get_page_insights', { documentId });
    expect(JSON.parse(insights.content[0]!.text)).toMatchObject({ documentId, byClass: { human: 1 } });
  });
});
