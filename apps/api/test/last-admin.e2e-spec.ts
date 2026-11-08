import { randomUUID } from 'node:crypto';
import { createPrismaService, type PrismaService } from '../src/prisma/prisma.service.js';
import { removeMemberGuarded, setRoleGuarded } from '../src/workspaces/membership-guards.js';

/**
 * #808 against live Postgres (`make infra-up`, apps/api/.env): the last two
 * admins demoting or removing each other at once leave one admin. The fake
 * Prisma cannot show this — it is write skew under READ COMMITTED, which needs
 * two real connections. The first write is held open inside its transaction
 * while the second runs, which is the interleaving that used to commit both.
 */
describe('last admin under concurrent writes (e2e, #808)', () => {
  let prisma: PrismaService;
  const workspaceId = randomUUID();
  const nonce = workspaceId.slice(0, 8);
  let a: string;
  let b: string;

  const admins = () => prisma.workspaceMember.count({ where: { workspaceId, role: 'admin' } });

  /** Run `first` in a transaction held open until `second` has had 300 ms to run against it. */
  async function interleave(first: () => Promise<boolean>, second: () => Promise<boolean>): Promise<boolean[]> {
    let wrote!: () => void;
    const firstWrote = new Promise<void>((r) => (wrote = r));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const one = prisma.withTransaction(async () => {
      const ok = await first();
      wrote();
      await held;
      return ok;
    });
    await firstWrote;
    // Started outside the first callback, so it gets its own connection and transaction.
    const two = second();
    await new Promise((r) => setTimeout(r, 300));
    release();
    return Promise.all([one, two]);
  }

  beforeAll(async () => {
    prisma = createPrismaService();
    await prisma.$connect();
    await prisma.workspace.create({ data: { id: workspaceId, name: `last-admin ${nonce}` } });
    const user = (who: string) =>
      prisma.user.create({ data: { email: `last-admin-${who}-${nonce}@example.test`, displayName: `Admin ${who}`, isAdmin: false } });
    [a, b] = (await Promise.all([user('a'), user('b')])).map((u) => u.id);
  });

  beforeEach(async () => {
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.createMany({
      data: [
        { workspaceId, userId: a, role: 'admin' },
        { workspaceId, userId: b, role: 'admin' },
      ],
    });
  });

  afterAll(async () => {
    await prisma?.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma?.user.deleteMany({ where: { email: { contains: `-${nonce}@example.test` } } });
    await prisma?.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma?.$disconnect();
  });

  it('two admins demoting each other leave one admin', async () => {
    const results = await interleave(
      () => setRoleGuarded(prisma, workspaceId, b, 'editor'),
      () => setRoleGuarded(prisma, workspaceId, a, 'editor'),
    );
    expect(results).toEqual([true, false]);
    expect(await admins()).toBe(1);
  });

  it('two admins removing each other leave one admin', async () => {
    const results = await interleave(
      () => removeMemberGuarded(prisma, workspaceId, b),
      () => removeMemberGuarded(prisma, workspaceId, a),
    );
    expect(results).toEqual([true, false]);
    expect(await admins()).toBe(1);
  });

  it('a demotion and a removal leave one admin', async () => {
    const results = await interleave(
      () => removeMemberGuarded(prisma, workspaceId, b),
      () => setRoleGuarded(prisma, workspaceId, a, 'viewer'),
    );
    expect(results).toEqual([true, false]);
    expect(await admins()).toBe(1);
  });
});
