import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type MemoryBank, type MemoryOperation } from '@prisma/client';
import { UUID_RE, type Locale } from '@knowledge/contracts';
import { randomUUID } from 'node:crypto';
import { requeueStale, staleFailure } from '../common/requeue-stale.js';
import type { Env } from '../config/env.js';
import { asLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { RetainItem } from './memory-facts.js';
import { maskItems, MemoryRetainService } from './memory-retain.service.js';
import { MemoryProducer } from './memory.producer.js';
import type { CancelOperationResponse, OperationResponse, OperationStatusResponse, OperationsListResponse } from './memory-wire.js';

/** Our row status, as Hindsight names it on the wire. */
const WIRE_STATUS = { queued: 'pending', running: 'processing', completed: 'completed', failed: 'failed', cancelled: 'cancelled' } as const;
type Status = keyof typeof WIRE_STATUS;
const ROW_STATUS = Object.fromEntries(Object.entries(WIRE_STATUS).map(([row, wire]) => [wire, row])) as Record<string, Status>;
const wireStatus = (row: Pick<MemoryOperation, 'status'>) => WIRE_STATUS[row.status as Status] ?? 'failed';

/** A queued row this old has outlived any honest queue delay: its job is taken for lost and enqueued again. */
const LOST_JOB_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
const SWEEP_PAGE = 50;

function operation(row: MemoryOperation): OperationResponse {
  return {
    id: row.id,
    task_type: row.type,
    operation_id: row.id,
    operation_type: row.type,
    items_count: row.itemsCount,
    document_id: null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    status: wireStatus(row),
    error_message: row.error,
    retry_count: Math.max(0, row.attempts - 1),
  };
}

/**
 * Async retain (#986 phase 3): the operation rows, on both sides of the queue.
 *
 * The API stores a row holding the masked items and enqueues a job carrying
 * its id; the worker claims the row with one guarded statement, runs the same
 * `MemoryRetainService` a sync retain runs, and settles it. The row is the
 * truth: a job the queue lost, or a worker that died holding one, is found by
 * the row (`sweep`, called from the API-side sweeper).
 */
@Injectable()
export class MemoryOperationsService {
  private readonly logger = new Logger(MemoryOperationsService.name);
  private readonly timeoutMs: number;
  private readonly retentionMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly retainer: MemoryRetainService,
    private readonly producer: MemoryProducer,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = config.get('MEMORY_OPERATION_TIMEOUT_MS', { infer: true });
    this.retentionMs = config.get('MEMORY_OPERATION_RETENTION_DAYS', { infer: true }) * 86_400_000;
  }

  /**
   * Stores an async retain and enqueues it. `operationId` is the client's, and
   * the row's identity: sent again for the same bank it returns the operation
   * it already made and creates no work; an id another operation holds is a 409.
   * The items are masked here, before the row exists.
   */
  async submit(bank: MemoryBank, input: { items: RetainItem[]; userId: string; locale: Locale; operationId?: string | null }): Promise<string> {
    const id = input.operationId ?? randomUUID();
    try {
      await this.prisma.memoryOperation.create({
        data: {
          id,
          workspaceId: bank.workspaceId,
          bankId: bank.id,
          payload: maskItems(input.items) as unknown as Prisma.InputJsonArray,
          itemsCount: input.items.length,
          createdBy: input.userId,
          locale: input.locale,
        },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const held = await this.prisma.memoryOperation.findUnique({ where: { id }, select: { bankId: true } });
      if (held?.bankId !== bank.id) throw new ConflictException(t('error.memory.operationIdTaken'));
      return id;
    }
    // A failed enqueue leaves the row queued, and the sweeper enqueues it again.
    await this.producer.enqueue(id).catch((e: Error) => this.logger.warn(`Memory operation ${id} not enqueued, the sweeper will: ${e.message}`));
    return id;
  }

  /** The worker's half: claim, retain, settle. A row another worker claimed, or that is no longer queued, is left alone. */
  async run(operationId: string): Promise<void> {
    const claimed = await this.prisma.memoryOperation.updateMany({
      where: { id: operationId, status: 'queued' },
      data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return;
    const row = await this.prisma.memoryOperation.findUnique({ where: { id: operationId }, include: { bank: true } });
    if (!row) return;
    try {
      await this.retainer.retain({
        workspaceId: row.workspaceId,
        bank: row.bank,
        userId: row.createdBy,
        locale: asLocale(row.locale),
        items: row.payload as unknown as RetainItem[],
        operationId: row.id,
      });
      // The memories hold the text now; the row keeps no second copy of it.
      await this.settle(row.id, { status: 'completed', payload: [] });
    } catch (e) {
      this.logger.warn(`Memory operation ${row.id} failed: ${(e as Error).message}`);
      await this.settle(row.id, { status: 'failed', error: (e as Error).message.slice(0, 1000), payload: [] });
    }
  }

  private async settle(id: string, data: { status: Status; error?: string; payload: [] }): Promise<void> {
    await this.prisma.memoryOperation.updateMany({ where: { id, status: 'running' }, data: { ...data, completedAt: new Date() } });
  }

  async list(bank: MemoryBank, query: { status?: string; type?: string; limit?: number; offset?: number }): Promise<OperationsListResponse> {
    const where: Prisma.MemoryOperationWhereInput = {
      bankId: bank.id,
      // A status this server never writes matches nothing, rather than everything.
      ...(query.status ? { status: ROW_STATUS[query.status] ?? '' } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const [rows, total] = await Promise.all([
      this.prisma.memoryOperation.findMany({ where, orderBy: { createdAt: 'desc' }, skip: offset, take: limit }),
      this.prisma.memoryOperation.count({ where }),
    ]);
    return { bank_id: bank.bankId, total, limit, offset, operations: rows.map(operation) };
  }

  /** One operation of this bank. An id it does not hold — never made, or purged since — reads `not_found`, as Hindsight's does. */
  async status(bank: MemoryBank, operationId: string): Promise<OperationStatusResponse> {
    const row = UUID_RE.test(operationId) ? await this.prisma.memoryOperation.findFirst({ where: { id: operationId, bankId: bank.id } }) : null;
    if (!row) return { operation_id: operationId, status: 'not_found' };
    const { id, task_type, operation_type, created_at, updated_at, error_message, retry_count } = operation(row);
    return { operation_id: id, id, status: wireStatus(row), operation_type, task_type, created_at, updated_at, completed_at: row.completedAt?.toISOString() ?? null, error_message, retry_count };
  }

  /** Cancels an operation no worker has claimed. One guarded statement: a claim that got there first wins. */
  async cancel(bank: MemoryBank, operationId: string): Promise<CancelOperationResponse> {
    const cancelled = UUID_RE.test(operationId)
      ? await this.prisma.memoryOperation.updateMany({ where: { id: operationId, bankId: bank.id, status: 'queued' }, data: { status: 'cancelled', completedAt: new Date(), payload: [] } })
      : { count: 0 };
    if (cancelled.count === 0) throw new ConflictException(t('error.memory.operationNotPending', { id: operationId }));
    return { success: true, message: `Operation ${operationId} cancelled`, operation_id: operationId };
  }

  /** Pending and failed operations of a bank, for its stats. */
  async counts(bankId: string): Promise<{ pending: number; failed: number }> {
    const [pending, failed] = await Promise.all([
      this.prisma.memoryOperation.count({ where: { bankId, status: { in: ['queued', 'running'] } } }),
      this.prisma.memoryOperation.count({ where: { bankId, status: 'failed' } }),
    ]);
    return { pending, failed };
  }

  /**
   * The due checks, called on the API-side tick:
   * - a queued row whose job the queue lost is enqueued again (same job id, so
   *   a job that is merely waiting absorbs it);
   * - a row a dead worker left claimed goes back to the queue, or fails once it
   *   has used its attempts (`requeueStale`);
   * - a finished row past its retention is deleted.
   */
  async sweep(now = Date.now()): Promise<{ enqueued: number; requeued: number; failed: number; purged: number }> {
    const lost = await this.prisma.memoryOperation.findMany({
      where: { status: 'queued', updatedAt: { lt: new Date(now - LOST_JOB_MS) } },
      select: { id: true, attempts: true },
      take: SWEEP_PAGE,
    });
    for (const row of lost) await this.producer.enqueue(row.id, row.attempts);
    const { requeued, failed } = await requeueStale({
      staleField: 'updatedAt',
      staleMs: this.timeoutMs,
      maxAttempts: MAX_ATTEMPTS,
      find: (where) => this.prisma.memoryOperation.findMany({ where, select: { id: true, attempts: true }, take: SWEEP_PAGE }),
      attemptOf: (row) => row.attempts,
      requeue: (where) => this.prisma.memoryOperation.updateMany({ where, data: { status: 'queued' } }),
      fail: (where, row) => this.prisma.memoryOperation.updateMany({ where, data: { status: 'failed', completedAt: new Date(), error: staleFailure(row.attempts), payload: [] } }),
      enqueue: (row) => this.producer.enqueue(row.id, row.attempts),
    });
    const purged = await this.prisma.memoryOperation.deleteMany({
      where: { status: { in: ['completed', 'failed', 'cancelled'] }, completedAt: { lt: new Date(now - this.retentionMs) } },
    });
    return { enqueued: lost.length, requeued: requeued.length, failed: failed.length, purged: purged.count };
  }
}
