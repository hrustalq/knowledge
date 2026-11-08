import { randomUUID } from 'node:crypto';
import { addToRun, NO_COUNTS } from '../src/connectors/connectors.service.js';
import { MergeRequestsService } from '../src/documents/merge-requests.service.js';
import { createPrismaService, type PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #810 against live Postgres (`make infra-up`, apps/api/.env): the two writes
 * that became raw SQL — an MR approval appended in one statement, and a
 * connector run's counters and warnings added rather than replaced. The fake
 * Prisma only replays their values; this runs the SQL itself, from two
 * connections at once.
 */
describe('guarded transitions (e2e, #810)', () => {
  let prisma: PrismaService;
  const workspaceId = randomUUID();
  const nonce = workspaceId.slice(0, 8);
  let projectId: string;
  let documentId: string;
  let mrId: string;
  let runId: string;

  beforeAll(async () => {
    prisma = createPrismaService();
    await prisma.$connect();
    projectId = (await prisma.project.create({ data: { workspaceId, name: `guarded ${nonce}` } })).id;
    documentId = (await prisma.document.create({ data: { workspaceId, projectId, title: `guarded ${nonce}` } })).id;
    const [main, feature] = await Promise.all(
      ['main', 'feature'].map((name) => prisma.documentBranch.create({ data: { documentId, name } })),
    );
    mrId = (
      await prisma.mergeRequest.create({
        data: { documentId, sourceBranchId: feature!.id, targetBranchId: main!.id, title: 'x', authorId: randomUUID() },
      })
    ).id;
    const connector = await prisma.connector.create({ data: { workspaceId, projectId, kind: 'confluence', name: `guarded ${nonce}` } });
    runId = (
      await prisma.connectorRun.create({ data: { connectorId: connector.id, workspaceId, direction: 'pull', trigger: 'manual' } })
    ).id;
  });

  afterAll(async () => {
    await prisma?.connectorRun.deleteMany({ where: { workspaceId } });
    await prisma?.connector.deleteMany({ where: { workspaceId } });
    await prisma?.mergeRequest.deleteMany({ where: { documentId } });
    await prisma?.documentBranch.deleteMany({ where: { documentId } });
    await prisma?.document.deleteMany({ where: { workspaceId } });
    await prisma?.project.deleteMany({ where: { workspaceId } });
    await prisma?.$disconnect();
  });

  it('two concurrent approvals both count, and a repeat adds nothing', async () => {
    const _ = {} as never;
    const svc = new MergeRequestsService(prisma, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _);
    // Both approvals read the merge request before either writes: the
    // interleaving that lost one when the read array was written back.
    const read = (svc as unknown as { getMrOrThrow: (id: string) => Promise<unknown> }).getMrOrThrow.bind(svc);
    let arrived = 0;
    let go!: () => void;
    const bothRead = new Promise<void>((r) => (go = r));
    Object.assign(svc, {
      recordActivity: async () => undefined,
      toDetail: async () => ({}),
      getMrOrThrow: async (id: string) => {
        const mr = await read(id);
        if (++arrived === 2) go();
        await bothRead;
        return mr;
      },
    });
    const [a, b] = [randomUUID(), randomUUID()];
    await Promise.all([svc.approve(mrId, a), svc.approve(mrId, b)]);
    arrived = 1;
    await svc.approve(mrId, a);
    const row = await prisma.mergeRequest.findUniqueOrThrow({ where: { id: mrId } });
    expect((row.approvedBy as string[]).sort()).toEqual([a, b].sort());
  });

  it('a closed merge request takes no approval', async () => {
    await prisma.mergeRequest.update({ where: { id: mrId }, data: { status: 'closed' } });
    const _ = {} as never;
    const svc = new MergeRequestsService(prisma, _, _, _, _, _, _, _, _, _, _, _, _, _, _, _);
    await expect(svc.approve(mrId, randomUUID())).rejects.toMatchObject({ status: 400 });
    await prisma.mergeRequest.update({ where: { id: mrId }, data: { status: 'open' } });
  });

  it('two writers add to one run: counters sum, warnings append in order and stop at the cap', async () => {
    const warning = (message: string) => ({ externalId: null, title: null, message });
    await Promise.all([
      addToRun(prisma, runId, { ...NO_COUNTS, created: 2, failed: 1 }, [warning('slice')]),
      addToRun(prisma, runId, { ...NO_COUNTS, updated: 3, failed: 1 }, [warning('task')]),
    ]);
    let row = await prisma.connectorRun.findUniqueOrThrow({ where: { id: runId } });
    expect({ created: row.created, updated: row.updated, failed: row.failed }).toEqual({ created: 2, updated: 3, failed: 2 });
    expect((row.warnings as { message: string }[]).map((w) => w.message).sort()).toEqual(['slice', 'task']);

    await addToRun(prisma, runId, NO_COUNTS, Array.from({ length: 300 }, (_, i) => warning(`w${i}`)));
    row = await prisma.connectorRun.findUniqueOrThrow({ where: { id: runId } });
    const messages = (row.warnings as { message: string }[]).map((w) => w.message);
    expect(messages).toHaveLength(200);
    expect(messages.slice(2, 4)).toEqual(['w0', 'w1']);
  });
});
