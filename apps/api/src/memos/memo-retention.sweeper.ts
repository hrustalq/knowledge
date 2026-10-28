import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

const SWEEP_INTERVAL_MS = 10 * 60_000;
const BATCH = 50;
/** A reserved memo whose bytes never arrived is abandoned after this. */
const PENDING_TTL_MS = 24 * 60 * 60_000;

/**
 * Memos' retention (#551, docs/features/68), a due check inside a fixed tick
 * like every scheduled job here. Audio older than `MEMO_AUDIO_RETENTION_DAYS`
 * is purged — every version, the bucket being versioned — and stamped, while
 * the transcript and the proposals stay. A memo still moving keeps its audio
 * until it settles. A reservation never finalized is deleted after a day.
 * Worker-only, beside the transcription job that reads the same objects.
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
