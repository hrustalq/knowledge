import { randomUUID } from 'node:crypto';
import { AnalyticsRecorder, type AnalyticsCaller } from '../src/analytics/analytics.recorder.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #79 phase 2: the heartbeat's guarded UPDATE against real PostgreSQL — the
 * part a mocked Prisma cannot show. Time only grows, never past the cap, and a
 * heartbeat moves only a web row the same reader opened. Needs the database
 * only (`make infra-up`); rows are written directly into a throwaway
 * workspace id and deleted after.
 */
describe('page-view heartbeat (e2e, #79)', () => {
  const WS = randomUUID();
  const CAP = 60_000;
  let prisma: PrismaService;
  let rec: AnalyticsRecorder;

  const person = (userId: string): Principal => ({ ...DEV_PRINCIPAL, userId, mode: 'session', isAdmin: false });
  const ann: AnalyticsCaller = { principal: person('ann') };
  const bob: AnalyticsCaller = { principal: person('bob') };

  async function view(caller: AnalyticsCaller, channel = 'web'): Promise<string> {
    const id = randomUUID();
    await prisma.pageView.create({
      data: { id, workspaceId: WS, documentId: randomUUID(), channel, readerKey: rec.readerKey(caller, WS) },
    });
    return id;
  }
  const activeMs = async (id: string) => (await prisma.pageView.findUniqueOrThrow({ where: { id } })).activeMs;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) process.loadEnvFile('.env');
    prisma = new PrismaService();
    await prisma.$connect();
    const env: Record<string, unknown> = { ANALYTICS_ENABLED: true, ANALYTICS_READER_SECRET: 'e2e', ANALYTICS_READ_TIME_CAP_MS: CAP };
    rec = new AnalyticsRecorder(prisma, { get: (k: string) => env[k] } as never);
  });

  afterAll(async () => {
    await prisma.pageView.deleteMany({ where: { workspaceId: WS } });
    await prisma.$disconnect();
  });

  it('grows monotonically and stops at the cap', async () => {
    const id = await view(ann);
    await rec.heartbeat(ann, id, 15_000);
    expect(await activeMs(id)).toBe(15_000);
    await rec.heartbeat(ann, id, 5_000); // a late, out-of-order beat
    expect(await activeMs(id)).toBe(15_000);
    await rec.heartbeat(ann, id, 10 * CAP);
    expect(await activeMs(id)).toBe(CAP);
  });

  it("leaves another reader's view, and a non-web view, unchanged", async () => {
    const annView = await view(ann);
    await rec.heartbeat(bob, annView, 30_000);
    expect(await activeMs(annView)).toBe(0);

    const agentView = await view(ann, 'mcp');
    await rec.heartbeat(ann, agentView, 30_000);
    expect(await activeMs(agentView)).toBe(0);
  });

  it('matches a do-not-track view only to a do-not-track beat', async () => {
    const id = await view({ ...ann, noTrack: true });
    await rec.heartbeat(ann, id, 20_000);
    expect(await activeMs(id)).toBe(0);
    await rec.heartbeat({ ...bob, noTrack: true }, id, 20_000);
    expect(await activeMs(id)).toBe(20_000);
  });
});
