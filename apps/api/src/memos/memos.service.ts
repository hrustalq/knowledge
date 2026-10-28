import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Memo } from '@prisma/client';
import {
  MEMO_FORMATS,
  memoExtensionFor,
  type AgentFinding,
  type CreateMemoResponse,
  type MemoDetailResponse,
  type MemoDropped,
  type MemoInfo,
  type MemoListResponse,
  type MemoSegment,
  type MemoStatus,
  type MemoTranscriptionState,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import type { Principal } from '../auth/principal.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { MemosProducer } from './memos.producer.js';
import { formatBytes } from '../common/format-bytes.js';
import { currentLocale } from '../i18n/locale.js';
import { t } from '../i18n/t.js';

export interface CreateMemoInput {
  workspaceId: string;
  projectId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  title?: string;
  /** What the browser read from the file's metadata; the worker's ffprobe has the last word. */
  durationSeconds?: number;
}

/**
 * Memos (#551, docs/features/68), the controller-free half: the REST
 * controller and the MCP tools both read through here.
 *
 * A memo is its uploader's alone. Every read goes through `require`, which
 * matches `created_by` unless the caller is a platform admin, and a memo that
 * is not yours is a 404 that names nothing — not a 403, which would confirm
 * it exists. The route's `@Access` has already checked the workspace role.
 */
@Injectable()
export class MemosService {
  private readonly maxBytes: number;
  private readonly maxMinutes: number;
  private readonly transcription: MemoTranscriptionState;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly permissions: PermissionService,
    private readonly usage: AiUsageService,
    private readonly producer: MemosProducer,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('MEMO_MAX_BYTES', { infer: true });
    this.maxMinutes = config.get('MEMO_MAX_MINUTES', { infer: true });
    this.transcription = transcriptionState(
      config.get('TRANSCRIPTION_PROVIDER', { infer: true }),
      config.get('TRANSCRIPTION_BASE_URL', { infer: true }),
    );
  }

  async list(principal: Principal, workspaceId: string, projectId?: string): Promise<MemoListResponse> {
    const rows = await this.prisma.memo.findMany({
      where: { workspaceId, createdBy: principal.userId, ...(projectId ? { projectId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      omit: { transcript: true, dropped: true, summary: true },
    });
    return {
      memos: rows.map(toInfo),
      transcription: this.transcription,
      limits: { maxBytes: this.maxBytes, maxMinutes: this.maxMinutes },
    };
  }

  /**
   * Step 1: the row and a presigned PUT. Every refusal that can be known
   * before the upload is made here — a two-hour file told it is the wrong
   * type once it has finished uploading is the rudest thing a form can do.
   */
  async create(principal: Principal, input: CreateMemoInput): Promise<CreateMemoResponse> {
    if (!this.transcription.enabled) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: t('error.memo.disabled', { variable: this.transcription.missing }),
        reason: 'transcription-disabled',
        missing: this.transcription.missing,
      });
    }
    const ext = memoExtensionFor(input.filename, input.contentType);
    if (!ext) {
      throw new UnsupportedMediaTypeException(
        t('error.memo.unsupportedFormat', {
          filename: input.filename,
          accepted: MEMO_FORMATS.map((f) => f.extension).join(', '),
        }),
      );
    }
    if (input.sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException(
        t('error.memo.tooLarge', { size: formatBytes(input.sizeBytes), limit: formatBytes(this.maxBytes) }),
      );
    }
    if (input.durationSeconds !== undefined && input.durationSeconds > this.maxMinutes * 60) {
      throw new PayloadTooLargeException(
        t('error.memo.tooLong', { minutes: Math.ceil(input.durationSeconds / 60), limit: this.maxMinutes }),
      );
    }
    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!project) throw new BadRequestException(t('error.project.notFound', { id: input.projectId }));
    const scope = await this.permissions.scopeFor(principal, input.workspaceId);
    await this.permissions.requireLevel(scope, { type: 'project', id: project.id }, 'view');
    await this.usage.assertWithinBudget(input.workspaceId, principal.userId);

    // The stored type is the format's own, never the client's: the audio
    // route serves it inline, and a claimed `text/html` must not render.
    const contentType = MEMO_FORMATS.find((f) => f.extension === ext)!.contentTypes[0]!;
    const row = await this.prisma.memo.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: project.id,
        createdBy: principal.userId,
        title: (input.title?.trim() || input.filename.replace(/\.[^.]+$/, '')).slice(0, 300),
        filename: input.filename,
        contentType,
        sizeBytes: input.sizeBytes,
        durationSeconds: input.durationSeconds === undefined ? null : Math.round(input.durationSeconds),
        // Placeholder: the key needs the id the insert just minted.
        audioKey: '',
        // Frozen here: the worker and the sweeper run with no request to read it from.
        locale: currentLocale(),
      },
    });
    const audioKey = this.storage.memoObjectKey(row.workspaceId, row.id, `source${ext}`);
    const updated = await this.prisma.memo.update({ where: { id: row.id }, data: { audioKey } });
    return {
      memo: toInfo(updated),
      upload: {
        url: await this.storage.presignPut(audioKey, contentType),
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    };
  }

  /**
   * Step 2: the bytes are up. The size is re-read from the bucket rather than
   * trusted — a presigned PUT is a capability, and one that checks only the
   * claimed size checks nothing.
   */
  async finalize(principal: Principal, memoId: string): Promise<MemoInfo> {
    const row = await this.require(principal, memoId);
    if (row.status !== 'pending') throw new ConflictException(t('error.memo.alreadyUploaded'));
    const head = await this.storage.headObject(row.audioKey);
    if (!head) throw new BadRequestException(t('error.memo.uploadMissing'));
    if (head.contentLength > this.maxBytes) {
      await this.storage.deleteObject(row.audioKey).catch(() => undefined);
      await this.prisma.memo.delete({ where: { id: row.id } });
      throw new PayloadTooLargeException(
        t('error.memo.tooLarge', { size: formatBytes(head.contentLength), limit: formatBytes(this.maxBytes) }),
      );
    }
    // Guarded on `pending`, so a double finalize moves the row once.
    const claimed = await this.prisma.memo.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'uploaded', sizeBytes: head.contentLength },
    });
    if (claimed.count === 0) throw new ConflictException(t('error.memo.alreadyUploaded'));
    await this.producer.enqueue(row.id);
    return toInfo({ ...row, status: 'uploaded', sizeBytes: head.contentLength });
  }

  async get(principal: Principal, memoId: string): Promise<MemoDetailResponse> {
    const row = await this.require(principal, memoId);
    // The kept proposals are the run's findings — the one copy the publisher
    // writes merge request ids into.
    const run = row.agentRunId
      ? await this.prisma.agentRun.findFirst({ where: { id: row.agentRunId, workspaceId: row.workspaceId }, select: { findings: true } })
      : null;
    const findings = Array.isArray(run?.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    return {
      memo: toInfo(row),
      transcript: Array.isArray(row.transcript) ? (row.transcript as unknown as MemoSegment[]) : [],
      summary: row.summary,
      proposals: findings.map((f) => ({
        action: f.memo?.action ?? (f.documentIds[0] ? 'update' : 'create'),
        title: f.title,
        detail: f.detail,
        documentId: f.documentIds[0] ?? null,
        documentTitle: f.documentTitles[0] ?? null,
        segments: f.memo?.segments ?? [],
        mergeRequestId: f.mergeRequestId ?? null,
      })),
      dropped: Array.isArray(row.dropped) ? (row.dropped as unknown as MemoDropped[]) : [],
    };
  }

  /**
   * Resume a failed memo from the step it failed in: one with a transcript
   * is read again (a new `secretary` run), one without is transcribed again.
   * Guarded on `failed`, so a double press queues once.
   */
  async retry(principal: Principal, memoId: string): Promise<MemoInfo> {
    const row = await this.require(principal, memoId);
    const transcribed = Array.isArray(row.transcript);
    if (!transcribed && !this.transcription.enabled) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: t('error.memo.disabled', { variable: this.transcription.missing }),
        reason: 'transcription-disabled',
        missing: this.transcription.missing,
      });
    }
    const status = transcribed ? 'transcribed' : 'uploaded';
    const claimed = await this.prisma.memo.updateMany({
      where: { id: row.id, status: 'failed' },
      data: { status, stage: null, error: null, publishedAt: null },
    });
    if (claimed.count === 0) throw new ConflictException(t('error.memo.notRetryable'));
    await this.producer.enqueue(row.id);
    return toInfo({ ...row, status, stage: null, error: null });
  }

  /**
   * The audio — every version of it, since the bucket is versioned — and the
   * row with its transcript. Merge requests it opened are ordinary merge
   * requests and stay; their links to the memo then 404 like any other.
   */
  async remove(principal: Principal, memoId: string): Promise<{ deleted: true }> {
    const row = await this.require(principal, memoId);
    await this.prisma.memo.delete({ where: { id: row.id } });
    if (row.audioKey) await this.storage.purgeObjectVersions(row.audioKey).catch(() => undefined);
    return { deleted: true };
  }

  /** A short-lived read URL: `<audio>` cannot send an Authorization header. */
  async audioUrl(principal: Principal, memoId: string): Promise<string> {
    const row = await this.require(principal, memoId);
    if (row.audioPurgedAt || row.status === 'pending') throw new GoneException(t('error.memo.audioGone'));
    return this.storage.presignGet(row.audioKey, {
      filename: `${row.title}${row.audioKey.slice(row.audioKey.lastIndexOf('.'))}`,
      contentType: row.contentType,
      disposition: 'inline',
    });
  }

  private async require(principal: Principal, memoId: string): Promise<Memo> {
    const row = await this.prisma.memo.findFirst({
      where: { id: memoId, ...(principal.isAdmin ? {} : { createdBy: principal.userId }) },
    });
    if (!row) throw new NotFoundException(t('error.memo.notFound'));
    return row;
  }
}

export function transcriptionState(provider: string, baseUrl: string): MemoTranscriptionState {
  if (provider === 'none') return { enabled: false, missing: 'TRANSCRIPTION_PROVIDER' };
  if (!baseUrl.trim()) return { enabled: false, missing: 'TRANSCRIPTION_BASE_URL' };
  return { enabled: true, missing: null };
}

function toInfo(row: Omit<Memo, 'transcript' | 'dropped' | 'summary'>): MemoInfo {
  return {
    memoId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    title: row.title,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    durationSeconds: row.durationSeconds,
    language: row.language,
    status: row.status as MemoStatus,
    stage: row.stage,
    error: row.error,
    audioAvailable: !row.audioPurgedAt && row.status !== 'pending',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
