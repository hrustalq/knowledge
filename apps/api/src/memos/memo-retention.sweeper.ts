import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { MemosProducer } from './memos.producer.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;
const BATCH = 50;
/** A reserved memo whose bytes never arrived is abandoned after this. */
const PENDING_TTL_MS = 24 * 60 * 60_000;
/** An `uploaded` or resumed `transcribed` memo this long untouched has probably lost its job (#657). */
const STALE_QUEUED_MS = 10 * 60_000;

/**
 * Memos' retention (#551, docs/features/68), a due check inside a fixed tick
 * like every scheduled job here. Audio older than `MEMO_AUDIO_RETENTION_DAYS`
 * is purged — every version, the bucket being versioned — and stamped, while
 * the transcript and the proposals stay. A memo still moving keeps its audio
 * until it settles. A reservation never finalized is deleted after a day.
 * Worker-only, beside the transcription job that reads the same objects.
 *
 * It is also the memos' outbox relay (#657): `finalize` and `retry` commit the
 * row and then enqueue, and `retry` only takes a `failed` memo, so one whose
 * enqueue was lost sat `uploaded` forever. `jobId = memo id`, and the job is
 * removed on either outcome, so the relay re-adds it exactly when it is gone.
 */
@Injectable()
export class MemoRetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoRetentionSweeper.name);
  private readonly retentionDays: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly producer: MemosProducer,
    config: ConfigService<Env, true>,
  ) {
    this.retentionDays = config.get('MEMO_AUDIO_RETENTION_DAYS', { infer: true });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const stale = await this.prisma.memo.findMany({
        where: {
          status: { in: ['uploaded', 'transcribed'] },
          updatedAt: { lt: new Date(now.getTime() - STALE_QUEUED_MS) },
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: BATCH,
      });
      for (const memo of stale) {
        this.logger.log(`Re-enqueueing stale memo ${memo.id}`);
        await this.producer.enqueue(memo.id);
      }
      if (this.retentionDays > 0) {
        const expired = await this.prisma.memo.findMany({
          where: {
            audioPurgedAt: null,
            status: { in: ['done', 'failed'] },
            createdAt: { lt: new Date(now.getTime() - this.retentionDays * 86_400_000) },
          },
          select: { id: true, audioKey: true },
          take: BATCH,
        });
        for (const memo of expired) {
          await this.storage.purgeObjectVersions(memo.audioKey);
          await this.prisma.memo.update({ where: { id: memo.id }, data: { audioPurgedAt: now } });
        }
      }
      const abandoned = await this.prisma.memo.findMany({
        where: { status: 'pending', createdAt: { lt: new Date(now.getTime() - PENDING_TTL_MS) } },
        select: { id: true, audioKey: true },
        take: BATCH,
      });
      for (const memo of abandoned) {
        if (memo.audioKey) await this.storage.purgeObjectVersions(memo.audioKey);
        await this.prisma.memo.deleteMany({ where: { id: memo.id, status: 'pending' } });
      }
    } catch (error) {
      this.logger.warn(`Memo retention sweep failed (non-fatal): ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
