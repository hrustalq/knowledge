import { randomUUID } from 'node:crypto';
import { AdminErrorsService } from '../src/admin/admin-errors.service.js';
import { OpsRetentionSweeper } from '../src/observability/ops-retention.sweeper.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #1240: the errors list against real PostgreSQL — the fingerprint is regex
 * SQL a mocked Prisma cannot run. Needs the database only (`make infra-up`);
 * everything lives under a throwaway workspace and is deleted after.
 */
describe('admin errors (e2e, #1240)', () => {
  const WS = randomUUID();
  const TRACE = `e2e-${randomUUID()}`;
  const DAY = 86_400_000;
  let prisma: PrismaService;
  let svc: AdminErrorsService;
  const config = { get: (key: string) => (key === 'OPS_SINK_ENABLED' ? true : 30) } as never;

  const event = (message: string, over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    traceId: randomUUID(),
    source: 'http',
    process: 'api',
    level: 'error',
    message,
    workspaceId: WS,
    fields: { ctx: 'DocumentsService', err: { type: 'Error', message, stack: `Error: ${message}\n    at find (documents.service.ts:1:1)` } },
    ...over,
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    svc = new AdminErrorsService(prisma, config);
    await prisma.workspace.create({ data: { id: WS, name: 'e2e admin errors' } });
    // Twenty repeats that differ only in the id, the number and the quoted value.
    await prisma.opsEvent.createMany({
      data: Array.from({ length: 20 }, (_, i) =>
        event(`Document ${randomUUID()} not found after ${i} tries in "${randomUUID().slice(0, 8)}"`, i === 0 ? { traceId: TRACE } : {}),
      ),
    });
    await prisma.opsEvent.create({ data: event('Connection refused', { process: 'worker', source: 'job' }) });
    // A catch-all logs one sentence for every failure; the error's own message tells them apart.
    const unhandled = (err: string) =>
      event('Unhandled exception', { source: 'ws', fields: { ctx: 'ApiExceptionFilter', err: { type: 'Error', message: err } } });
    await prisma.opsEvent.createMany({ data: [unhandled('Redis is down'), unhandled('Redis is down'), unhandled('Disk full')] });
  });

  afterAll(async () => {
    await prisma.opsEvent.deleteMany({ where: { workspaceId: WS } });
    await prisma.workspace.delete({ where: { id: WS } });
    await prisma.$disconnect();
  });

  it('groups twenty identical errors into one group with count 20', async () => {
    const res = await svc.list({ hours: 24, workspaceIds: [WS], processes: ['api'] });
    expect(res.groups.map((g) => g.count).sort((a, b) => a - b)).toEqual([1, 2, 20]);
    const big = res.groups.find((g) => g.count === 20)!;
    expect(big).toMatchObject({ source: 'http', context: 'DocumentsService', processes: ['api'], workspaceCount: 1 });
    expect(big.detail).toBeNull(); // the error's message is the log message: nothing more to say
    expect(res.workspaces).toContainEqual({ workspaceId: WS, name: 'e2e admin errors', count: 24 });
    expect(res.retentionDays).toBe(30);
  });

  it("splits a catch-all's failures by the error's own message", async () => {
    const res = await svc.list({ hours: 24, workspaceIds: [WS], text: 'Unhandled' });
    expect(res.groups.map((g) => [g.detail, g.count])).toEqual(expect.arrayContaining([['Redis is down', 2], ['Disk full', 1]]));
    expect(res.groups).toHaveLength(2);
  });

  it('refuses a cursor whose date does not exist, instead of failing in SQL', async () => {
    await expect(svc.list({ hours: 24, cursor: `2026-02-31T00:00:00.000000Z~${'0'.repeat(32)}` })).rejects.toMatchObject({ status: 400 });
    await expect(svc.list({ hours: 24, cursor: `2026-13-45T00:00:00.000000Z~${'0'.repeat(32)}` })).rejects.toMatchObject({ status: 400 });
  });

  it('filters by process and finds a trace id through the text filter', async () => {
    const worker = await svc.list({ hours: 24, workspaceIds: [WS], processes: ['worker'] });
    expect(worker.groups.map((g) => g.message)).toEqual(['Connection refused']);
    const traced = await svc.list({ hours: 24, text: TRACE });
    expect(traced.groups).toHaveLength(1);
    expect(traced.groups[0]!.count).toBe(1);
  });

  it('pages with a cursor that neither repeats nor skips a group', async () => {
    const all = await svc.list({ hours: 24, workspaceIds: [WS] });
    expect(all.nextCursor).toBeNull();
    // Rebuild the cursor the way a page boundary would, after the first group.
    const first = all.groups[0]!;
    const [row] = await prisma.$queryRaw<Array<{ at: string }>>`
      SELECT to_char(max(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM ops_events WHERE id = ${first.latestId}::uuid`;
    const rest = await svc.list({ hours: 24, workspaceIds: [WS], cursor: `${row!.at}~${first.fingerprint}` });
    expect(rest.groups.map((g) => g.fingerprint)).toEqual(all.groups.slice(1).map((g) => g.fingerprint));
  });

  it('opens one error with its trace id, context, stack and group', async () => {
    const traced = await svc.list({ hours: 24, text: TRACE });
    const res = await svc.get(traced.groups[0]!.latestId);
    expect(res.event).toMatchObject({ traceId: TRACE, context: 'DocumentsService', workspaceName: 'e2e admin errors', process: 'api' });
    expect(res.event.stack).toContain('documents.service.ts');
    expect(res.group.count).toBe(20);
    expect(res.recent).toHaveLength(20);
  });

  it('purges rows older than the retention window', async () => {
    const old = await prisma.opsEvent.create({ data: { ...event('old'), createdAt: new Date(Date.now() - 40 * DAY) } });
    await new OpsRetentionSweeper(prisma, config).sweep();
    expect(await prisma.opsEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.opsEvent.count({ where: { workspaceId: WS } })).toBe(24);
  });
});
