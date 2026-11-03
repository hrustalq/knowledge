import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { isScaffoldStub, scaffoldStubSql, SCAFFOLD_ORIGIN } from '../src/common/scaffold-stub.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * #716: `isScaffoldStub` and its SQL twin `scaffoldStubSql` agree, page for
 * page, in real PostgreSQL — the default-branch head join is SQL a mocked
 * Prisma cannot run. Needs the database only (`make infra-up`); everything is
 * written under throwaway ids and deleted after.
 */
describe('scaffold stubs (e2e, #716)', () => {
  const WS = randomUUID();
  const P = randomUUID();
  const USER = randomUUID();
  let prisma: PrismaService;

  // name → [default branch, branches: name → revision origins in order (last = head; [] = no head)]
  const pages: Record<string, { defaultBranch: string; branches: Record<string, Array<string | null>> }> = {
    stub: { defaultBranch: 'main', branches: { main: [SCAFFOLD_ORIGIN] } },
    edited: { defaultBranch: 'main', branches: { main: [SCAFFOLD_ORIGIN, null] } },
    ordinary: { defaultBranch: 'main', branches: { main: [null] } },
    headless: { defaultBranch: 'main', branches: { main: [] } },
    otherDefault: { defaultBranch: 'trunk', branches: { main: [SCAFFOLD_ORIGIN], trunk: [null] } },
  };
  const ids = Object.fromEntries(Object.keys(pages).map((k) => [k, randomUUID()]));
  const heads = new Map<string, { origin: string | null } | null>();

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    await prisma.project.create({ data: { id: P, workspaceId: WS, name: 'scaffold-stub e2e' } });
    for (const [name, page] of Object.entries(pages)) {
      const id = ids[name]!;
      await prisma.document.create({
        data: { id, workspaceId: WS, projectId: P, title: name, defaultBranch: page.defaultBranch, path: `/${id}/` },
      });
      let number = 0;
      for (const [branchName, origins] of Object.entries(page.branches)) {
        const branch = await prisma.documentBranch.create({ data: { documentId: id, name: branchName } });
        let head: { id: string; origin: string | null } | null = null;
        for (const origin of origins) {
          head = await prisma.documentRevision.create({
            data: { documentId: id, branchId: branch.id, revisionNumber: ++number, contentType: 'text/markdown', s3Key: '', authorId: USER, status: 'indexed', origin },
          });
        }
        if (head) await prisma.documentBranch.update({ where: { id: branch.id }, data: { headRevisionId: head.id } });
        if (branchName === page.defaultBranch) heads.set(id, head);
      }
    }
  });

  afterAll(async () => {
    const docIds = Object.values(ids);
    await prisma.documentRevision.deleteMany({ where: { documentId: { in: docIds } } });
    await prisma.documentBranch.deleteMany({ where: { documentId: { in: docIds } } });
    await prisma.document.deleteMany({ where: { id: { in: docIds } } });
    await prisma.project.deleteMany({ where: { id: P } });
    await prisma.$disconnect();
  });

  it('marks the same pages in TypeScript and in SQL', async () => {
    const inMemory = Object.values(ids).filter((id) => isScaffoldStub(heads.get(id))).sort();
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT d.id FROM documents d WHERE d.project_id = ${P}::uuid AND ${scaffoldStubSql('d')}`);
    expect(inMemory).toEqual([ids.stub]);
    expect(rows.map((r) => r.id).sort()).toEqual(inMemory);
  });
});
