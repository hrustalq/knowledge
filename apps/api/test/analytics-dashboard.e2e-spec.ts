import { randomUUID } from 'node:crypto';
import { AnalyticsQueryService } from '../src/analytics/analytics-query.service.js';
import { AnalyticsRetentionSweeper } from '../src/analytics/analytics-retention.sweeper.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #79 phase 4: the workspace rollups and retention against real PostgreSQL —
 * the repeat-collapsing window, click-through over the clicks join, and the
 * per-workspace retention clamp are SQL a mocked Prisma cannot run. Needs the
 * database only (`make infra-up`); rows are written under throwaway workspace
 * ids and deleted after.
 */
describe('analytics dashboard (e2e, #79)', () => {
  const WS = randomUUID();
  const OTHER_WS = randomUUID();
  const KEY = randomUUID();
  const DOC = randomUUID();
  const MIN = 60_000;
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(Date.now() - ms);

  let prisma: PrismaService;
  let svc: AnalyticsQueryService;

  async function search(over: { hash: string; text?: string | null; results: number; channel?: string; reader?: string | null; at: Date; ws?: string }) {
    const id = randomUUID();
    await prisma.searchQuery.create({
      data: {
        id,
        workspaceId: over.ws ?? WS,
        queryHash: over.hash,
        queryText: over.text === undefined ? over.hash : over.text,
        mode: 'hybrid',
        resultCount: over.results,
        resultDocIds: [],
        channel: over.channel ?? 'web',
        readerKey: over.reader === undefined ? 'ann' : over.reader,
        apiKeyId: over.channel === 'mcp' ? KEY : null,
        durationMs: 3,
        createdAt: over.at,
      },
    });
    return id;
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    const config = { get: (k: string) => ({ ANALYTICS_DEAD_PAGE_DAYS: 90, ANALYTICS_RETENTION_DAYS: 180, ANALYTICS_QUERY_TEXT_DAYS: 90 })[k] };
    svc = new AnalyticsQueryService(prisma, config as never, { enabled: async () => true } as never);

    // `alpha`: ann runs it, toggles a filter 3 s later (one intent), runs it
    // again half an hour on, and opens result 3 of the first run.
    const first = await search({ hash: 'alpha', results: 4, at: ago(60 * MIN) });
    await search({ hash: 'alpha', results: 4, at: new Date(Date.now() - 60 * MIN + 3000) });
    await search({ hash: 'alpha', results: 4, at: ago(30 * MIN) });
    await prisma.pageView.create({
      data: { id: randomUUID(), workspaceId: WS, documentId: DOC, channel: 'web', readerKey: 'ann', searchId: first, searchRank: 3, createdAt: ago(59 * MIN) },
    });
    // `zilch` finds nothing, for two people; `nobody` finds results nobody opens.
    await search({ hash: 'zilch', results: 0, reader: 'ann', at: ago(20 * MIN) });
    await search({ hash: 'zilch', results: 0, reader: 'bob', at: ago(19 * MIN) });
    await search({ hash: 'nobody', results: 2, reader: 'bob', at: ago(10 * MIN) });
    // An agent's search finds results and never clicks — agents cannot, so it is not "no click".
    await search({ hash: 'agentq', results: 2, channel: 'mcp', reader: null, at: ago(5 * MIN) });
    // Old enough that retention has redacted its text; it still groups by hash.
    await search({ hash: 'old', text: null, results: 1, at: ago(20 * DAY) });
    await search({ hash: 'elsewhere', results: 0, ws: OTHER_WS, at: ago(MIN) });

    await prisma.mcpToolCall.createMany({
      data: [
        { workspaceId: WS, tool: 'knowledge_search', ok: true, apiKeyId: KEY, durationMs: 10, createdAt: ago(MIN) },
        { workspaceId: WS, tool: 'knowledge_search', ok: false, errorCode: 'tool-error', apiKeyId: KEY, durationMs: 30, createdAt: ago(MIN) },
        { workspaceId: WS, tool: 'knowledge_whoami', ok: true, durationMs: 1, createdAt: ago(MIN) },
      ],
    });
  });

  afterAll(async () => {
    const workspaceId = { in: [WS, OTHER_WS] };
    await prisma.pageView.deleteMany({ where: { workspaceId } });
    await prisma.searchQuery.deleteMany({ where: { workspaceId } });
    await prisma.mcpToolCall.deleteMany({ where: { workspaceId } });
    await prisma.workspaceSettings.deleteMany({ where: { workspaceId } });
    await prisma.$disconnect();
  });

  it('collapses a reader repeating a query, and measures click-through over web searches', async () => {
    const r = await svc.search(WS, 30);
    const alpha = r.top.find((q) => q.queryHash === 'alpha')!;
    expect(alpha.searches).toBe(2);
    expect(alpha.clickThrough).toBe(0.5);
    expect(alpha.meanClickedRank).toBe(3);
    expect(r.top.find((q) => q.queryHash === 'old')?.queryText).toBeNull();
    expect(r.top.map((q) => q.queryHash)).not.toContain('elsewhere');
  });

  it('lists what found nothing and what found results nobody opened', async () => {
    const r = await svc.search(WS, 30);
    expect(r.zeroResult.map((q) => [q.queryHash, q.zeroResults])).toEqual([['zilch', 2]]);
    expect(new Set(r.noClick.map((q) => q.queryHash))).toEqual(new Set(['nobody', 'old']));
  });

  it('narrows searches to one traffic class', async () => {
    const r = await svc.search(WS, 30, 'agent');
    expect(r.top.map((q) => q.queryHash)).toEqual(['agentq']);
    expect(r.noClick).toEqual([]);
  });

  it('adds up the overview from the same rows', async () => {
    const r = await svc.overview(systemScope(WS), 30);
    // alpha 2, zilch 2, nobody 1, agentq 1, old 1
    expect(r.searches).toBe(7);
    expect(r.zeroResultSearches).toBe(2);
    // One click over the web searches that found something: alpha 2, nobody 1, old 1.
    expect(r.clickThrough).toBe(0.25);
    expect(r.mcpCalls).toBe(3);
    expect((await svc.overview(systemScope(WS), 30, 'human')).mcpCalls).toBeNull();
  });

  it('ranks MCP tools and keys, a deleted key by id alone', async () => {
    const r = await svc.agents(WS, 30);
    expect(r.tools[0]).toMatchObject({ tool: 'knowledge_search', calls: 2, errors: 1, medianMs: 20 });
    expect(r.keys).toEqual([{ apiKeyId: KEY, name: null, prefix: null, mcpCalls: 2, views: 0, searches: 1 }]);
  });

  it('exports a table with its query text', async () => {
    const { columns, rows } = await svc.report(systemScope(WS), 'search-zero-result', 30);
    expect(columns[1]).toBe('query_text');
    expect(rows).toEqual([['zilch', 'zilch', 2, 2, null, null, expect.any(String)]]);
  });

  it('deletes past each workspace\'s own retention, and redacts old query text', async () => {
    await prisma.workspaceSettings.create({ data: { workspaceId: WS, analyticsRetentionDays: 7 } });
    await search({ hash: 'stale', results: 1, at: ago(10 * DAY) });
    await search({ hash: 'stale', results: 1, ws: OTHER_WS, at: ago(10 * DAY) });
    const ancient = await search({ hash: 'ancient', results: 1, ws: OTHER_WS, at: ago(100 * DAY) });
    const config = { get: (k: string) => ({ ANALYTICS_RETENTION_DAYS: 180, ANALYTICS_QUERY_TEXT_DAYS: 90 })[k] };
    await new AnalyticsRetentionSweeper(prisma, config as never).sweep();

    expect(await prisma.searchQuery.count({ where: { workspaceId: WS, queryHash: { in: ['stale', 'old'] } } })).toBe(0);
    expect(await prisma.searchQuery.count({ where: { workspaceId: OTHER_WS, queryHash: 'stale' } })).toBe(1);
    expect((await prisma.searchQuery.findUnique({ where: { id: ancient } }))?.queryText).toBeNull();
  });
});
