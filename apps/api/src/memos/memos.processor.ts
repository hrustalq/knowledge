import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';
import type { Env } from '../config/env.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { asLocale } from '../i18n/locale.js';
import { t, withLocale } from '../i18n/t.js';
import { CHUNK_SECONDS, probeSeconds, splitAudio } from './audio.js';
import { MEMO_QUEUE } from './memos.constants.js';
import { TranscriptionClient } from './transcription.client.js';
import { stitchTranscript, type ChunkTranscript } from './transcript.js';

/**
 * A memo's transcription (#551, docs/features/68): download → ffprobe the
 * length (the ceiling is enforced here, on the file, not on the browser's
 * word) → ffmpeg into ten-minute mp3 chunks → one speech call per chunk →
 * stitched and masked → written once. The unmasked text lives only in this
 * job's memory; the temp dir goes whatever happens.
 */
@Processor(MEMO_QUEUE)
export class MemosProcessor extends WorkerHost {
  private readonly logger = new Logger(MemosProcessor.name);
  private readonly maxMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly stt: TranscriptionClient,
    private readonly usage: AiUsageService,
    config: ConfigService<Env, true>,
  ) {
    super();
    this.maxMinutes = config.get('MEMO_MAX_MINUTES', { infer: true });
  }

  async process(job: Job<{ memoId: string }>): Promise<void> {
    const row = await this.prisma.memo.findUnique({ where: { id: job.data.memoId } });
    if (!row) return;
    // Claimed in one statement: a redelivered job, or a memo already past this
    // step, transcribes nothing.
    const claimed = await this.prisma.memo.updateMany({
      where: { id: row.id, status: { in: ['uploaded', 'failed'] }, transcript: { equals: Prisma.AnyNull } },
      data: { status: 'transcribing', stage: null, error: null },
    });
    if (claimed.count === 0) return;
    await withLocale(asLocale(row.locale), () => this.transcribe(row.id, row.workspaceId, row.createdBy, row.audioKey));
  }

  private async transcribe(memoId: string, workspaceId: string, userId: string, audioKey: string): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'memo-'));
    const started = Date.now();
    let seconds = 0;
    let failure: string | undefined;
    try {
      const source = join(dir, 'source');
      await this.storage.downloadToFile(audioKey, source);
      seconds = await probeSeconds(source);
      if (seconds > this.maxMinutes * 60) {
        throw new Error(t('error.memo.tooLong', { minutes: Math.ceil(seconds / 60), limit: this.maxMinutes }));
      }
      const chunks: ChunkTranscript[] = [];
      for (const chunk of await splitAudio(source, dir)) {
        chunks.push(await this.stt.transcribe(chunk.path, chunk.offset, Math.min(CHUNK_SECONDS, seconds - chunk.offset)));
      }
      const { segments, language } = stitchTranscript(chunks);
      await this.prisma.memo.update({
        where: { id: memoId },
        data: {
          status: 'transcribed',
          transcript: segments as unknown as Prisma.InputJsonValue,
          language,
          durationSeconds: Math.round(seconds),
        },
      });
    } catch (error) {
      failure = (error as Error).message || t('error.memo.transcriptionFailed');
      this.logger.warn(`Memo ${memoId} was not transcribed: ${failure}`);
      await this.prisma.memo.update({
        where: { id: memoId },
        data: { status: 'failed', stage: 'transcribing', error: failure.slice(0, 1000) },
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      // One row per attempt that reached the speech server's input: a file
      // refused before it was probed cost nothing.
      if (seconds > 0) {
        void this.usage.recordTranscription({
          workspaceId,
          userId,
          model: this.stt.model,
          audioSeconds: Math.round(seconds),
          durationMs: Date.now() - started,
          ok: !failure,
          ...(failure ? { error: failure } : {}),
        });
      }
    }
  }
}
