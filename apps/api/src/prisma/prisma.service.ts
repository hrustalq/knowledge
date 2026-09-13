import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
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
export function createPrismaService(): PrismaService {
  const base = new PrismaService();
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
      return Reflect.get(target, prop, receiver);
    },
  });
}
