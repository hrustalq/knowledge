import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { countQuery } from '@knowledge/observability';
import {
  NEVER_FROM_TRANSACTION,
  activeTransaction,
  deferUntilCommit,
  drainAfterCommit,
  runInTransaction,
} from './transaction.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Run `fn` inside one transaction, with every `PrismaService` write it reaches
   * — however many services deep — enrolled in it automatically.
   *
   * A nested call JOINS the open transaction instead of opening a second one.
   * That is not a convenience: `DocumentsService.createDocument` and
   * `finalizeRevision` already open transactions of their own, so an outer
   * boundary that did not absorb them would deadlock against its own connection.
   * Joining means the outermost `withTransaction` owns the commit, which is what
   * lets a caller make "create the page AND record what it belongs to" atomic
   * without any of the services in between knowing.
   *
   * The nested call also cannot set its own timeout — the outer one is already
   * running — so options are accepted only when this opens the transaction.
   */
  async withTransaction<T>(fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
    if (activeTransaction()) return fn();
    const [result, scope] = await this.$transaction((tx) => runInTransaction(tx, fn), options);
    // Only the outermost boundary reaches here, so this is the one commit — and
    // therefore the only place the deferred side effects may fire.
    await drainAfterCommit(scope);
    return result;
  }

  /**
   * Register a side effect to run after the outermost transaction commits, or
   * immediately when none is open. See `deferUntilCommit` for why post-commit
   * work cannot simply follow the call that scheduled it.
   */
  onCommit(fn: () => Promise<unknown>): void {
    deferUntilCommit(fn);
  }
}

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * The instance handed to every injection site.
 *
 * A proxy rather than a Prisma client extension: `$extends` returns a *new*
 * client and cannot redirect an already-injected one, and it would have to wrap
 * every model delegate by name. The proxy is one `get` trap and needs no edit
 * when the schema grows.
 *
 * Reads are routed too, not just writes. Inside a transaction a read that went
 * to the base client would sit outside it and miss the rows the transaction has
 * written — which is precisely the read-your-own-writes bug these boundaries
 * exist to prevent.
 */
export function createPrismaService(countQueries = false): PrismaService {
  const base = new PrismaService();
  const counted = countQueries ? withQueryCount(base) : undefined;
  return new Proxy(base, {
    get(target, prop, receiver) {
      const tx = activeTransaction();
      if (tx && !NEVER_FROM_TRANSACTION.has(prop)) {
        const fromTx = (tx as unknown as Record<string | symbol, unknown>)[prop];
        if (fromTx !== undefined) {
          // Bind so `$executeRaw` and friends keep the transaction as `this`;
          // model delegates are plain objects and pass through untouched.
          return typeof fromTx === 'function' ? fromTx.bind(tx) : fromTx;
        }
      }
      // Counting on: everything but this class's own methods goes to the
      // extended client, `$transaction` included, so a transaction client is
      // counted too.
      if (counted && !Object.hasOwn(PrismaService.prototype, prop) && prop in counted) {
        const fromCounted = (counted as unknown as Record<string | symbol, unknown>)[prop];
        return typeof fromCounted === 'function' ? fromCounted.bind(counted) : fromCounted;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * The client with every operation counted against the request trace (#1242).
 *
 * A query extension rather than `$on('query')`: the engine emits that event
 * outside the caller's async context, so it cannot tell which request ran the
 * query. The extension runs in the caller's context, inside interactive
 * transactions and for raw SQL alike. It counts operations, not SQL statements:
 * an `include` that Prisma splits into two statements is one.
 */
function withQueryCount(base: PrismaClient) {
  return base.$extends({
    query: {
      async $allOperations({ args, query }) {
        const startedAt = performance.now();
        try {
          return await query(args);
        } finally {
          countQuery(performance.now() - startedAt);
        }
      },
    },
  });
}
