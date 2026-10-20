import { randomUUID } from 'node:crypto';
import { AnalyticsQueryService } from '../src/analytics/analytics-query.service.js';
import { systemScope, type AccessScope } from '../src/permissions/access-scope.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { KnowledgeHealthService } from '../src/verification/knowledge-health.service.js';

/**
 * #79 phase 3: the rollups against real PostgreSQL — percentile_cont, COUNT
 * DISTINCT, the jsonb "surfaced by a search" join and the page-permission
 * predicate are SQL a mocked Prisma cannot run. Needs the database only
 * (`make infra-up`); everything is written under throwaway workspace ids and
 * deleted after.
 */
describe('analytics rollups (e2e, #79)', () => {
  const WS = randomUUID();
  const OTHER_WS = randomUUID();
  const P = randomUUID();
  const OTHER_P = randomUUID();
  const RESTRICTION = randomUUID();
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  // read: old, read in the app recently. surfaced: old, never read, but a
  // search returned it. dead: old, never read, never returned. hidden: read,
  // but restricted from the caller. fresh: created today, never read.
  const doc = { read: randomUUID(), surfaced: randomUUID(), dead: randomUUID(), hidden: randomUUID(), fresh: randomUUID() };
  const otherDoc = randomUUID();

  let prisma: PrismaService;
  let svc: AnalyticsQueryService;
  // A member the restriction is not granted to.
  let scope: AccessScope;

  async function view(documentId: string, channel: string, reader: string | null, at: Date, activeMs = 0, ws = WS) {
    await prisma.pageView.create({
      data: { id: randomUUID(), workspaceId: ws, documentId, channel, readerKey: reader, activeMs, createdAt: at },
    });
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new AnalyticsQueryService(prisma, { get: () => 90 } as never, { enabled: async () => true } as never);
    scope = { ...systemScope(WS), bypass: false, role: 'editor', denied: new Set([RESTRICTION]) };

    await prisma.project.createMany({
      data: [
        { id: P, workspaceId: WS, name: 'e2e analytics' },
        { id: OTHER_P, workspaceId: OTHER_WS, name: 'e2e analytics other' },
      ],
    });
    const page = (id: string, title: string, createdAt: Date, over: object = {}) => ({
      id, workspaceId: WS, projectId: P, title, createdAt, ...over,
    });
    await prisma.document.createMany({
      data: [
        page(doc.read, 'Read', ago(200)),
        page(doc.surfaced, 'Surfaced', ago(200)),
        page(doc.dead, 'Dead', ago(200)),
        page(doc.hidden, 'Hidden', ago(200), { restrictedBy: [RESTRICTION] }),
        page(doc.fresh, 'Fresh', new Date()),
        { id: otherDoc, workspaceId: OTHER_WS, projectId: OTHER_P, title: 'Elsewhere', createdAt: ago(200) },
      ],
    });

    // Collection began 120 days ago: it covers the 90-day dead window.
    await view(doc.read, 'web', 'ann', ago(120));
    await view(doc.read, 'web', 'ann', ago(2), 10_000);
    await view(doc.read, 'web', 'bob', ago(1), 30_000);
    await view(doc.read, 'web', null, ago(1)); // DNT: a view, not a reader, and no read time
    await view(doc.read, 'mcp', 'ann', ago(1));
    await view(doc.read, 'assistant', 'bob', ago(3));
    await view(doc.hidden, 'web', 'cid', ago(1), 50_000);
    await view(otherDoc, 'web', 'dan', ago(1), 70_000, OTHER_WS);
    await prisma.searchQuery.create({
      data: {
        id: randomUUID(), workspaceId: WS, queryHash: 'h', mode: 'hybrid', resultCount: 1,
        resultDocIds: [doc.surfaced], channel: 'web', durationMs: 5, createdAt: ago(10),
      },
    });
  });

  afterAll(async () => {
    const workspaceId = { in: [WS, OTHER_WS] };
    await prisma.pageView.deleteMany({ where: { workspaceId } });
    await prisma.searchQuery.deleteMany({ where: { workspaceId } });
    await prisma.document.deleteMany({ where: { workspaceId } });
    await prisma.project.deleteMany({ where: { workspaceId } });
    await prisma.$disconnect();
  });

  it('counts views by class, readers and median read time over visible pages only', async () => {
    const r = await svc.project(scope, P, 30);
    expect(r.views).toBe(5);
    expect(r.byClass).toEqual({ human: 3, assisted: 1, agent: 1 });
    expect(r.uniqueReaders).toBe(2);
    expect(r.medianReadMs).toBe(20_000);
    expect(r.topPages.map((p) => p.documentId)).toEqual([doc.read]);
    expect(r.series.reduce((n, d) => n + d.human + d.assisted + d.agent, 0)).toBe(5);
    expect(r.collectingSince).not.toBeNull();
  });

  it('narrows every number to one traffic class', async () => {
    const r = await svc.project(scope, P, 30, 'agent');
    expect(r.views).toBe(1);
    expect(r.byClass).toEqual({ human: 0, assisted: 0, agent: 1 });
    expect(r.medianReadMs).toBeNull();
  });

  it('lets an admin see the restricted page, and never another workspace', async () => {
    const r = await svc.project(systemScope(WS), P, 30);
    expect(r.views).toBe(6);
    expect(r.topPages.map((p) => p.title)).toEqual(['Read', 'Hidden']);
    expect(r.topPages.map((p) => p.title)).not.toContain('Elsewhere');
  });

  it('tells never-read pages from dead ones', async () => {
    const r = await svc.project(scope, P, 30);
    expect(new Set(r.neverRead.map((p) => p.documentId))).toEqual(new Set([doc.surfaced, doc.dead, doc.fresh]));
    // Surfaced by a search, too new, or read: not dead. Hidden: not listed at all.
    expect(r.dead.map((p) => p.documentId)).toEqual([doc.dead]);
  });

  it('answers one page with its last human view', async () => {
    const r = await svc.pageInsights(doc.read);
    expect(r.views).toBe(5);
    expect(r.uniqueReaders).toBe(2);
    expect(r.lastHumanViewAt).not.toBeNull();
    expect(new Date(r.lastHumanViewAt!).getTime()).toBeGreaterThan(ago(1.5).getTime());
  });

  it('files the same pages under the knowledge-health filters, with the last read on each row', async () => {
    const settings = { reviewIntervalDays: 0, remindBeforeDays: 0, inactiveAfterDays: 0, emptyMaxChars: 0, trustRanking: true };
    const health = new KnowledgeHealthService(
      prisma,
      { effective: async () => settings } as never,
      {} as never,
      { breadcrumbsFor: async () => new Map() } as never,
      {} as never,
      { get: () => 90 } as never,
    );
    const ids = async (filter: 'unread' | 'dead') =>
      new Set((await health.list(scope, { projectId: P, filter })).rows.map((r) => r.documentId));
    expect(await ids('dead')).toEqual(new Set([doc.dead]));
    expect(await ids('unread')).toEqual(new Set([doc.surfaced, doc.dead]));
    const all = await health.list(scope, { projectId: P });
    expect(all.rows.find((r) => r.documentId === doc.read)?.lastReadAt).not.toBeNull();
    expect(all.rows.find((r) => r.documentId === doc.dead)?.lastReadAt).toBeNull();
    const summary = await health.summary(scope, P);
    expect(summary.counts).toMatchObject({ unread: 2, dead: 1 });
  });

  it('calls nothing dead until collection covers the window', async () => {
    await prisma.pageView.deleteMany({ where: { workspaceId: WS, createdAt: { lt: ago(100) } } });
    const r = await svc.project(scope, P, 30);
    expect(r.dead).toEqual([]);
    expect(r.neverRead.length).toBe(3);
  });
});
