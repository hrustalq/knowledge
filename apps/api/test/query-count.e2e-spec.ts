import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeBacktest, configureBacktest, queriesOf, startTrace, withTrace } from '@knowledge/observability';
import { traceMiddleware } from '@knowledge/observability/express';
import { createPrismaService, type PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #1242: OPS_QUERY_COUNT_ENABLED counts Prisma operations against the request
 * that ran them. Real PostgreSQL, because the point is the async context: the
 * engine's `$on('query')` event loses it, the query extension must not, inside
 * `withTransaction` and for raw SQL too. Needs the database only.
 */
describe('per-request query count (e2e, #1242)', () => {
  let counted: PrismaService;
  let plain: PrismaService;

  beforeAll(async () => {
    counted = createPrismaService(true);
    plain = createPrismaService(false);
    await Promise.all([counted.$connect(), plain.$connect()]);
  });
  afterAll(async () => {
    await Promise.all([counted.$disconnect(), plain.$disconnect()]);
  });

  it('counts model, raw and in-transaction operations against the scope that ran them', async () => {
    const ctx = startTrace('http');
    const other = startTrace('http');
    await withTrace(ctx, async () => {
      await counted.workspace.findFirst();
      await counted.$queryRaw`select 1`;
      await counted.withTransaction(async () => {
        await counted.workspace.count();
        await counted.$executeRawUnsafe('select 1');
      });
    });
    // Awaited inside: a PrismaPromise is lazy and runs in whatever scope awaits it.
    await withTrace(other, async () => {
      await counted.workspace.count();
    });
    expect(queriesOf(ctx)?.queries).toBe(4);
    expect(queriesOf(other)?.queries).toBe(1);
  });

  it('counts nothing when off', async () => {
    const ctx = startTrace('http');
    await withTrace(ctx, () => plain.workspace.findFirst());
    expect(queriesOf(ctx)).toBeUndefined();
  });

  it('puts the count on the http.request event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qc-'));
    configureBacktest({ enabled: true, dir, service: 'api' });
    let finish = () => {};
    const res = { statusCode: 200, setHeader: () => undefined, getHeader: () => undefined, on: (_: 'finish', fn: () => void) => (finish = fn) };
    await new Promise<void>((done) =>
      traceMiddleware({ method: 'GET', url: '/v1/x', headers: {} }, res, () => void counted.workspace.count().then(() => done())),
    );
    finish();
    closeBacktest();
    await new Promise((r) => setTimeout(r, 50));
    configureBacktest({ enabled: false });
    const [file] = readdirSync(dir);
    const event = JSON.parse(readFileSync(join(dir, file), 'utf8').trim()) as { queries?: number; queryMs?: number };
    expect(event.queries).toBe(1);
    expect(event.queryMs).toBeGreaterThanOrEqual(0);
  });
});
