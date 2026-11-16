import { randomUUID } from 'node:crypto';
import { AnalyticsQueryService } from '../src/analytics/analytics-query.service.js';
import { systemScope } from '../src/permissions/access-scope.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #1195: ticket-context injections against real PostgreSQL — the jsonb page
 * list, the follow-up EXISTS and GROUPING SETS are SQL a mocked Prisma cannot
 * run. Needs the database only; rows are written under a throwaway workspace.
 */
describe('context injection rollup (e2e, #1195)', () => {
  const WS = randomUUID();
  const KEY = randomUUID();
  const OTHER_KEY = randomUUID();
  const MIN = 60_000;
  const t0 = new Date(Date.now() - 6 * 60 * MIN);
  const at = (minutes: number) => new Date(t0.getTime() + minutes * MIN);
  const pages = Array.from({ length: 8 }, () => randomUUID());

  let prisma: PrismaService;
  let svc: AnalyticsQueryService;

  const injection = (minutes: number, docs: string[], tokens: number, count = docs.length) => ({
    id: randomUUID(), workspaceId: WS, queryHash: `ctx-${minutes}`, mode: 'context', resultCount: count, resultDocIds: docs,
    resultTokens: tokens, channel: 'mcp', apiKeyId: KEY, durationMs: 5, createdAt: at(minutes),
  });
  const view = (documentId: string, minutes: number, apiKeyId = KEY, channel = 'mcp') => ({
    id: randomUUID(), workspaceId: WS, documentId, channel, apiKeyId, createdAt: at(minutes),
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new AnalyticsQueryService(prisma, { get: () => 90 } as never, { enabled: async () => true } as never);
    await prisma.searchQuery.createMany({
      data: [
        injection(0, pages.slice(0, 4), 500),
        injection(10, pages.slice(4), 300),
        injection(20, [], 30, 0),
        // A person's search: not an injection, and still the only search the dashboard counts.
        { id: randomUUID(), workspaceId: WS, queryHash: 'person', mode: 'hybrid', resultCount: 1, resultDocIds: [pages[0]!], channel: 'web', durationMs: 5, createdAt: at(1) },
      ],
    });
    await prisma.pageView.createMany({
      data: [
        view(pages[0]!, 30), // followed: same key, same channel, inside two hours
        view(pages[0]!, 40), // the same page again: still one followed page
        view(pages[1]!, -1), // before the injection
        view(pages[2]!, 30, KEY, 'web'), // another channel
        view(pages[4]!, 30, OTHER_KEY), // another key
        view(pages[5]!, 10 + 121), // past the window
      ],
    });
  });

  afterAll(async () => {
    await prisma.pageView.deleteMany({ where: { workspaceId: WS } });
    await prisma.searchQuery.deleteMany({ where: { workspaceId: WS } });
    await prisma.$disconnect();
  });

  it('reports injections, median tokens, empty rate and follow-up over the window and per day', async () => {
    const res = await svc.context(WS, new Date(t0.getTime() - MIN));
    expect(res).toMatchObject({ injections: 3, medianTokens: 300, followUpRate: 1 / 8 });
    expect(res.emptyRate).toBeCloseTo(1 / 3);
    expect(res.days.reduce((n, d) => n + d.injections, 0)).toBe(3);
    expect(res.days.every((d) => d.channel === 'mcp')).toBe(true);
  });

  it('a window with no injection reports zero and no rates', async () => {
    expect(await svc.context(WS, new Date())).toEqual({ injections: 0, medianTokens: null, emptyRate: null, followUpRate: null, days: [] });
  });

  it('keeps injections out of the search dashboard', async () => {
    const overview = await svc.overview(systemScope(WS), 30);
    expect(overview).toMatchObject({ searches: 1, zeroResultSearches: 0 });
    expect((await svc.search(WS, 30)).top.map((q) => q.queryHash)).toEqual(['person']);
  });
});
