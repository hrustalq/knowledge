import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Hold `key` until the open transaction commits or rolls back (#815). Two
 * writers that lock the same key run their "is there one already?" read and
 * their insert one after the other, so a double click or a burst of events
 * yields one row. Prefix every key with what it guards (`agent-run:…`).
 *
 * Re-entrant within a transaction, and a no-op outside one, so call it inside a
 * boundary — or use `withSubjectLock`. Taking two keys? Always in the same
 * order everywhere, or two writers can deadlock.
 */
export async function lockSubject(db: Pick<PrismaService, '$executeRaw'>, key: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Run `fn` in a transaction that first takes the lock on `key`. Joins an outer
 * `withTransaction`, so the lock is then held until that one commits. Enqueue
 * jobs after this returns (or via `prisma.onCommit`), never inside `fn`: the
 * worker would race to a row that is not committed yet.
 */
export function withSubjectLock<T>(prisma: PrismaService, key: string, fn: () => Promise<T>): Promise<T> {
  return prisma.withTransaction(async () => {
    await lockSubject(prisma, key);
    return fn();
  });
}
