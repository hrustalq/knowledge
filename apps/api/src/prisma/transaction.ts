import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Module-level because this file is free functions, not a provider. Routed
 * through Nest's Logger rather than console so it picks up the ambient trace
 * context and the ops_events sink like every other record.
 */
const logger = new Logger('Transaction');

/**
 * Ambient transaction scope.
 *
 * The problem this exists for: `DocumentsService.createDocument` and
 * `finalizeRevision` each open their own `$transaction` and commit before
 * returning, so every caller that writes a bookkeeping row afterwards — the
 * merge request's status, `connector_links`, `import_jobs.documentId`,
 * `workflow_run_nodes.documentId`, an agent finding's `mergeRequestId` — has a
 * window in which the page exists and the row pointing at it does not. Each of
 * those windows produces either a duplicate page on the next attempt or a row
 * that can never be completed.
 *
 * None of it is fixable at the call site, because the boundary would have to
 * span three services that all take `PrismaService` and no client argument.
 * Threading `Prisma.TransactionClient` through every signature is the usual
 * answer and would touch all 51 services that inject Prisma.
 *
 * So: the same trick `i18n/t.ts` already uses for locale. The client lives in
 * AsyncLocalStorage, `PrismaService` prefers it when one is present, and
 * services keep their signatures. `withLocale` makes the argument in full —
 * ambient context reaches the services a path calls "without widening a single
 * service signature". This is that, for writes.
 *
 * The same caveat applies, too: work that outlives the request which started it
 * has no ambient scope. A BullMQ processor, a sweeper tick and a detached
 * continuation each have to open their own, exactly as they must call
 * `withLocale` rather than inherit one.
 */
interface TransactionScope {
  tx: Prisma.TransactionClient;
  /** Side effects deferred until the outermost commit — see `deferUntilCommit`. */
  afterCommit: Array<() => Promise<unknown>>;
}

const store = new AsyncLocalStorage<TransactionScope>();

/** The transaction this code is running inside, if any. */
export function activeTransaction(): Prisma.TransactionClient | undefined {
  return store.getStore()?.tx;
}

/** Run `fn` with `tx` ambient, returning the scope so the caller can drain it. */
export function runInTransaction<T>(
  tx: Prisma.TransactionClient,
  fn: () => Promise<T>,
): Promise<[T, TransactionScope]> {
  const scope: TransactionScope = { tx, afterCommit: [] };
  return store.run(scope, async (): Promise<[T, TransactionScope]> => [await fn(), scope]);
}

/**
 * Run `fn` once the outermost transaction commits — or immediately when there is
 * no transaction open.
 *
 * This is the half that makes the ambient boundary safe to use at all.
 * `DocumentsService.finalizeRevision` writes its `ingestion_jobs` row inside a
 * transaction and then enqueues the BullMQ job *after* it commits — the comment
 * at its outbox write says so explicitly, and it is correct: a job enqueued for
 * an uncommitted row races the worker to a row that is not there yet, and a job
 * enqueued for a row that then rolls back never has one.
 *
 * Wrapping such a method in an outer transaction turns its own `withTransaction`
 * into a join, so "after commit" silently becomes "before commit" and that
 * invariant inverts. Every post-commit side effect — queue enqueues, event
 * publishes, activity records — has to go through here instead, so it fires when
 * the OUTERMOST boundary commits, whichever one that turns out to be.
 *
 * Failures are swallowed, deliberately: these run after the data is durable, so
 * a failed enqueue is the outbox sweeper's problem and a failed publish is the
 * best-effort bus's, exactly as when they ran inline.
 *
 * They are logged, though. Swallowing a failure and having no record of it are
 * different things, and only the first was ever intended: with neither, a job
 * that was queued and failed to enqueue looked exactly like a job nobody ever
 * queued, and this is the single highest-traffic swallow in the codebase.
 */
export function deferUntilCommit(fn: () => Promise<unknown>): void {
  const scope = store.getStore();
  if (!scope) {
    void fn().catch((err: unknown) =>
      logger.warn({
        msg: 'Deferred effect failed (no transaction open, ran inline)',
        code: 'TX_AFTER_COMMIT_FAILED',
        err,
      }),
    );
    return;
  }
  scope.afterCommit.push(fn);
}

/** Drain a committed scope's deferred effects, in the order they were queued. */
export async function drainAfterCommit(scope: TransactionScope): Promise<void> {
  for (const fn of scope.afterCommit) {
    try {
      await fn();
    } catch (err) {
      // Still swallowed — see deferUntilCommit, the contract is deliberate and
      // the data is already durable. The loop must also continue: one failed
      // effect must not cancel the ones queued behind it.
      logger.warn({
        msg: 'Post-commit effect failed (best-effort by contract)',
        code: 'TX_AFTER_COMMIT_FAILED',
        err,
      });
    }
  }
}

/**
 * Property names that must always reach the real client, never the ambient
 * transaction.
 *
 * `$transaction` is the load-bearing one: a nested call has to be able to see
 * that a transaction is already open so it can join it (see
 * `PrismaService.withTransaction`). Postgres has no true nested transactions,
 * and Prisma's interactive client does not expose savepoints, so "join the
 * outer one" is the only correct semantics — and the outer commit is then the
 * only commit, which is exactly what the callers above need.
 *
 * The consequence is a trap, and it has already cost a production outage: since
 * `$transaction` is excluded here — and `Prisma.TransactionClient` does not
 * carry it anyway, so it would fall through regardless — calling
 * `prisma.$transaction(...)` inside an open boundary does NOT join. It opens a
 * second transaction on a second pooled connection. If that inner transaction
 * touches a row the outer one has locked, the two wait on each other forever:
 * the outer connection is `idle in transaction` rather than blocked, so
 * Postgres cannot see a cycle and its deadlock detector never fires. The
 * request hangs until something kills the connection, and each retry wedges
 * another pair until the pool starves.
 *
 * So: in any service that might run under an outer boundary, use
 * `withTransaction`, never `$transaction`. `DocumentsService.finalizeRevision`
 * is the worked example — it deadlocked against
 * `MergeRequestsService.merge`'s `document_branches ... FOR UPDATE`.
 *
 * The lifecycle methods are here because Nest calls them on the provider, which
 * is the proxy; connecting or disconnecting a transaction client is meaningless.
 *
 * Everything else — every model delegate, plus `$executeRaw`/`$queryRaw` and
 * their unsafe twins — is present on `Prisma.TransactionClient` and should route
 * to it. That set is deliberately derived from what the type actually has rather
 * than enumerated here, so a Prisma upgrade that adds a delegate needs no edit.
 */
export const NEVER_FROM_TRANSACTION: ReadonlySet<string | symbol> = new Set([
  '$transaction',
  '$connect',
  '$disconnect',
  '$on',
  '$use',
  '$extends',
  'onModuleInit',
  'onModuleDestroy',
  'withTransaction',
  'onCommit',
]);
