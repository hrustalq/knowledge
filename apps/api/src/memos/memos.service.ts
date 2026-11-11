import {
  BadGatewayException,
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
import { Prisma, type Memo } from '@prisma/client';
import {
  MEMO_FORMATS,
  memoExtensionFor,
  memoProgressFor,
  type AgentFinding,
  type CreateMemoResponse,
  type MemoDetailResponse,
  type MemoDropped,
  type MemoInfo,
  type MemoListResponse,
  type MemoSegment,
  type MemoSource,
  type MemoSpeaker,
  type MemoTriage,
  type MemoType,
  type MemoStatus,
  type MemoTranscriptionState,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import type { Principal } from '../auth/principal.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PlaudError } from '../plaud/plaud.client.js';
import { effectiveMemoTypes, shippedMemoType } from './memo-types.js';
import { cleanTags } from './triage.js';
import { loadSpeakers, readChoices, speakerLabels } from './speakers.js';
import { PlaudService } from '../plaud/plaud.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { MemosProducer } from './memos.producer.js';
import { stitchTranscript } from './transcript.js';
import { formatBytes } from '../common/format-bytes.js';
import { currentLocale, t } from '../i18n/t.js';

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
  private readonly plaudTranscribeSeconds: number;
  private readonly transcription: MemoTranscriptionState;
  /** Mirrors `TranscriptionClient.speakers`, which lives in the worker's module. */
  private readonly speakers: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly permissions: PermissionService,
    private readonly usage: AiUsageService,
    private readonly producer: MemosProducer,
    config: ConfigService<Env, true>,
    private readonly plaud: PlaudService,
  ) {
    this.maxBytes = config.get('MEMO_MAX_BYTES', { infer: true });
    this.maxMinutes = config.get('MEMO_MAX_MINUTES', { infer: true });
    this.plaudTranscribeSeconds = config.get('PLAUD_TRANSCRIBE_MINUTES_PER_MONTH', { infer: true }) * 60;
    this.transcription = transcriptionState(
      config.get('TRANSCRIPTION_PROVIDER', { infer: true }),
      config.get('TRANSCRIPTION_BASE_URL', { infer: true }),
      config.get('TRANSCRIPTION_API_KEY', { infer: true }),
    );
    this.speakers = config.get('TRANSCRIPTION_PROVIDER', { infer: true }) === 'gen-api' && config.get('TRANSCRIPTION_SPEAKERS', { infer: true });
  }

  async list(principal: Principal, workspaceId: string, projectId?: string, type?: string, tag?: string): Promise<MemoListResponse> {
    const rows = await this.prisma.memo.findMany({
      where: { workspaceId, createdBy: principal.userId, ...(projectId ? { projectId } : {}), ...(type ? { type } : {}), ...(tag ? { tags: { array_contains: [tag] } } : {}) },
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
    this.assertTranscription();
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
    const project = await this.projectFor(principal, input.workspaceId, input.projectId);

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

  /**
   * A Plaud recording as a memo (#864), built from Plaud's own transcript: no
   * audio is copied and our speech-to-text never runs, so this works with
   * transcription off. The recording is read as the caller, from their own
   * Plaud sign-in. Importing one twice is one memo — the unique index decides,
   * so two racing imports cannot both insert.
   *
   * The transcript is masked by `stitchTranscript` before the one write, like
   * a transcribed memo's. The memo's title is ours, never Plaud's: the title
   * reaches the secretary outside the untrusted wrapper, and a Plaud name can
   * be text Plaud's model wrote from the recording. Plaud's name is kept as
   * the filename, which is only ever displayed.
   */
  async importPlaud(principal: Principal, input: { workspaceId: string; projectId: string; fileId: string }): Promise<MemoInfo> {
    const project = await this.projectFor(principal, input.workspaceId, input.projectId);
    const same = { workspaceId: input.workspaceId, createdBy: principal.userId, source: 'plaud', externalId: input.fileId };
    const existing = await this.prisma.memo.findFirst({ where: same });
    if (existing) return toInfo(existing);

    let recording, utterances;
    try {
      recording = await this.plaud.recording(principal.userId, input.fileId);
      utterances = recording && (await this.plaud.transcript(principal.userId, input.fileId));
    } catch (err) {
      if (!(err instanceof PlaudError)) throw err;
      throw new BadGatewayException({ statusCode: 502, message: t('error.memo.plaudFailed'), reason: 'plaud-failed' });
    }
    if (!recording || !utterances) {
      throw new ConflictException({ statusCode: 409, message: t('error.memo.plaudNotLinked'), reason: 'plaud-not-linked' });
    }
    if (recording.durationSeconds > this.maxMinutes * 60) {
      throw new PayloadTooLargeException(
        t('error.memo.tooLong', { minutes: Math.ceil(recording.durationSeconds / 60), limit: this.maxMinutes }),
      );
    }
    const { segments } = stitchTranscript([
      { offset: 0, duration: recording.durationSeconds, language: null, segments: utterances, text: '' },
    ]);
    // Plaud transcribes when the person asks it to. Until then there is nothing to import.
    if (!segments.length) {
      throw new ConflictException({ statusCode: 409, message: t('error.memo.plaudNotTranscribed'), reason: 'plaud-not-transcribed' });
    }

    let row: Memo;
    try {
      row = await this.prisma.memo.create({
        data: {
          ...same,
          projectId: project.id,
          title: plaudTitle(recording.startAt),
          filename: recording.name.slice(0, 255),
          contentType: '',
          durationSeconds: recording.durationSeconds,
          // No audio: the same state retention leaves a memo in.
          audioKey: '',
          audioPurgedAt: new Date(),
          status: 'transcribed',
          transcript: segments as unknown as Prisma.InputJsonValue,
          locale: currentLocale(),
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      return toInfo((await this.prisma.memo.findFirst({ where: same }))!);
    }
    // The memo job sends a transcribed memo straight to its analysis.
    await this.producer.enqueue(row.id);
    return toInfo(row);
  }

  async get(principal: Principal, memoId: string): Promise<MemoDetailResponse> {
    const row = await this.require(principal, memoId);
    // The kept proposals are the run's findings — the one copy the publisher
    // writes merge request ids into.
    const run = row.agentRunId
      ? await this.prisma.agentRun.findFirst({ where: { id: row.agentRunId, workspaceId: row.workspaceId }, select: { findings: true, status: true, createdAt: true, startedAt: true, finishedAt: true } })
      : null;
    const findings = Array.isArray(run?.findings) ? (run.findings as unknown as AgentFinding[]) : [];
    const memo = toInfo(row);
    return {
      memo,
      speakers: (await loadSpeakers(this.prisma, row)).speakers,
      triage: row.triage && typeof row.triage === 'object' ? (row.triage as unknown as MemoTriage) : null,
      progress: memoProgressFor(
        memo,
        run && {
          status: run.status,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
        },
      ),
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
   * The uploader's own name for it (#875) and what kind of recording it is
   * (#879). Anyone else gets the same bare 404 as on a read. A type must be
   * one the workspace offers; null takes it away.
   */
  async update(principal: Principal, memoId: string, input: { title?: string; type?: string | null; tags?: string[] }): Promise<MemoInfo> {
    const row = await this.require(principal, memoId);
    if (input.type) {
      const offered = (await this.types(row.workspaceId)).some((t) => t.key === input.type && !t.hidden);
      if (!offered) throw new BadRequestException(t('error.memo.typeUnknown'));
    }
    const data = {
      ...(input.title ? { title: input.title } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.tags ? { tags: cleanTags(input.tags) } : {}),
    };
    return toInfo(await this.prisma.memo.update({ where: { id: row.id }, data }));
  }

  /**
   * The owner's answer to a memo waiting in `review` (#879): what it is, where
   * it goes and its tags, theirs to change from what triage suggested. Then
   * on to the secretary. Guarded on `review`, so a double press queues once.
   * The project is checked like any memo's (`projectFor`): theirs to file into.
   */
  async confirm(principal: Principal, memoId: string, input: { type: string | null; projectId: string; tags: string[] }): Promise<MemoInfo> {
    const row = await this.require(principal, memoId);
    if (input.type) {
      const offered = (await this.types(row.workspaceId)).some((t) => t.key === input.type && !t.hidden);
      if (!offered) throw new BadRequestException(t('error.memo.typeUnknown'));
    }
    const project = await this.projectFor(principal, row.workspaceId, input.projectId);
    const data = { status: 'transcribed', type: input.type, projectId: project.id, tags: cleanTags(input.tags) };
    const claimed = await this.prisma.memo.updateMany({ where: { id: row.id, status: 'review' }, data });
    if (claimed.count === 0) throw new ConflictException(t('error.memo.notInReview'));
    await this.producer.enqueue(row.id);
    return toInfo({ ...row, ...data });
  }

  /** The workspace's catalogue of memo types (#879): built-ins as its rows left them, then its own. */
  async types(workspaceId: string): Promise<MemoType[]> {
    return effectiveMemoTypes(await this.prisma.memoType.findMany({ where: { workspaceId } }));
  }

  /**
   * An admin's edit to one type: a built-in's override, or a type of the
   * workspace's own, which needs a name. Guidance written here becomes part
   * of the secretary's instructions for every member's memos of that type.
   */
  async saveType(
    principal: Principal,
    workspaceId: string,
    key: string,
    input: { name?: string | null; guidance?: string | null; hidden?: boolean; projectId?: string | null; auto?: boolean },
  ): Promise<MemoType[]> {
    const shipped = shippedMemoType(key);
    const builtIn = Boolean(shipped);
    // Sent back as shipped is "inherit", not an override: the row stays sparse and follows a later change to the built-in.
    const own = (value: string | null | undefined, original: string | undefined) => (value?.trim() && value.trim() !== original ? value.trim() : null);
    const existing = await this.prisma.memoType.findUnique({ where: { workspaceId_key: { workspaceId, key } } });
    const name = input.name === undefined ? existing?.name : own(input.name, shipped?.name);
    if (!builtIn && !name) throw new BadRequestException(t('error.memo.typeNeedsName'));
    const data = {
      name: name ?? null,
      ...(input.guidance !== undefined ? { guidance: own(input.guidance, shipped?.guidance) } : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
      ...(input.auto !== undefined ? { auto: input.auto } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    };
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true } });
      if (!project) throw new BadRequestException(t('error.project.notFound', { id: input.projectId }));
    }
    await this.prisma.memoType.upsert({
      where: { workspaceId_key: { workspaceId, key } },
      create: { workspaceId, key, createdBy: principal.userId, ...data },
      update: data,
    });
    return this.types(workspaceId);
  }

  /** Back to the built-in, or gone if it was the workspace's own. Memos keep the key; an unknown key reads as no type. */
  async removeType(workspaceId: string, key: string): Promise<MemoType[]> {
    await this.prisma.memoType.deleteMany({ where: { workspaceId, key } });
    return this.types(workspaceId);
  }

  /**
   * The uploader says who a speaker is, or that it is nobody here (#880).
   * The label must be one the transcript uses and the person a member of the
   * memo's workspace: a match names someone to the secretary, so neither is
   * taken on trust. Matching gives that person no access to the memo.
   */
  async matchSpeaker(principal: Principal, memoId: string, label: string, userId: string | null): Promise<MemoSpeaker[]> {
    const row = await this.require(principal, memoId);
    const labels = speakerLabels(Array.isArray(row.transcript) ? (row.transcript as unknown as MemoSegment[]) : []);
    if (!labels.includes(label)) throw new BadRequestException(t('error.memo.speakerUnknown'));
    if (userId) {
      const member = await this.prisma.workspaceMember.findFirst({ where: { workspaceId: row.workspaceId, userId }, select: { userId: true } });
      if (!member) throw new BadRequestException(t('error.memo.speakerNotMember'));
    }
    const speakers = { ...readChoices(row.speakers), [label]: userId };
    await this.prisma.memo.update({ where: { id: row.id }, data: { speakers } });
    return (await loadSpeakers(this.prisma, { ...row, speakers })).speakers;
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

  /**
   * "Transcribe here" (#864): our speech-to-text on a Plaud recording Plaud
   * has not transcribed. It is the one way that spend happens for a Plaud
   * recording, always the person's explicit act and never the sweeper's, and
   * everything that can refuse it is checked now: transcription on, the
   * project, the model budget, the length, and the person's allowance.
   *
   * The memo is queued like an upload with no copy of the audio; the worker
   * reads it from Plaud as the person. It has no speaker names.
   */
  async transcribePlaud(principal: Principal, input: { workspaceId: string; projectId: string; fileId: string }): Promise<MemoInfo> {
    this.assertTranscription();
    const project = await this.projectFor(principal, input.workspaceId, input.projectId);
    const same = { workspaceId: input.workspaceId, createdBy: principal.userId, source: 'plaud', externalId: input.fileId };
    const existing = await this.prisma.memo.findFirst({ where: same });
    if (existing) return toInfo(existing);

    let recording;
    try {
      recording = await this.plaud.recording(principal.userId, input.fileId);
    } catch (err) {
      if (!(err instanceof PlaudError)) throw err;
      throw new BadGatewayException({ statusCode: 502, message: t('error.memo.plaudFailed'), reason: 'plaud-failed' });
    }
    if (!recording) throw new ConflictException({ statusCode: 409, message: t('error.memo.plaudNotLinked'), reason: 'plaud-not-linked' });
    if (recording.durationSeconds > this.maxMinutes * 60) {
      throw new PayloadTooLargeException(
        t('error.memo.tooLong', { minutes: Math.ceil(recording.durationSeconds / 60), limit: this.maxMinutes }),
      );
    }
    const { remainingSeconds } = await this.plaudTranscribeAllowance(principal.userId, input.workspaceId);
    if (recording.durationSeconds > remainingSeconds) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.memo.plaudAllowance', { minutes: Math.floor(remainingSeconds / 60), needed: Math.ceil(recording.durationSeconds / 60) }),
        reason: 'plaud-transcribe-allowance',
        remainingSeconds,
      });
    }

    let row: Memo;
    try {
      row = await this.prisma.memo.create({
        data: {
          ...same,
          projectId: project.id,
          title: plaudTitle(recording.startAt),
          filename: recording.name.slice(0, 255),
          contentType: 'audio/mpeg',
          durationSeconds: recording.durationSeconds,
          audioKey: '',
          audioPurgedAt: new Date(),
          status: 'uploaded',
          locale: currentLocale(),
        },
      });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') throw err;
      return toInfo((await this.prisma.memo.findFirst({ where: same }))!);
    }
    await this.producer.enqueue(row.id);
    return toInfo(row);
  }

  /**
   * What is left of a person's allowance for "Transcribe here": the ceiling
   * less every second of speech transcribed for them in this workspace over
   * the last 30 days, uploads included. Read from `ai_usage`, not a counter.
   */
  // ponytail: a memo still being transcribed is not in ai_usage yet, so two quick presses can overshoot by one recording; count queued memos if that matters.
  async plaudTranscribeAllowance(userId: string, workspaceId: string): Promise<{ enabled: boolean; limitSeconds: number; remainingSeconds: number; speakers: boolean }> {
    const used = await this.prisma.aiUsage.aggregate({
      where: { workspaceId, userId, operation: 'transcription', createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      _sum: { audioSeconds: true },
    });
    const limitSeconds = this.plaudTranscribeSeconds;
    return {
      enabled: this.transcription.enabled && limitSeconds > 0,
      limitSeconds,
      remainingSeconds: Math.max(0, limitSeconds - (used._sum.audioSeconds ?? 0)),
      speakers: this.speakers,
    };
  }

  private assertTranscription(): void {
    if (this.transcription.enabled) return;
    throw new ServiceUnavailableException({
      statusCode: 503,
      message: t('error.memo.disabled', { variable: this.transcription.missing }),
      reason: 'transcription-disabled',
      missing: this.transcription.missing,
    });
  }

  /** The project a memo goes into: in this workspace, visible to the caller, and within the model budget. */
  private async projectFor(principal: Principal, workspaceId: string, projectId: string): Promise<{ id: string }> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true } });
    if (!project) throw new BadRequestException(t('error.project.notFound', { id: projectId }));
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    await this.permissions.requireLevel(scope, { type: 'project', id: project.id }, 'view');
    await this.usage.assertWithinBudget(workspaceId, principal.userId);
    return project;
  }

  private async require(principal: Principal, memoId: string): Promise<Memo> {
    const row = await this.prisma.memo.findFirst({
      where: { id: memoId, ...(principal.isAdmin ? {} : { createdBy: principal.userId }) },
    });
    if (!row) throw new NotFoundException(t('error.memo.notFound'));
    return row;
  }
}

/** Ours, never Plaud's name: the title reaches the secretary outside the untrusted wrapper. */
function plaudTitle(startAt: string | null): string {
  return `Plaud · ${(startAt ?? new Date().toISOString()).slice(0, 16).replace('T', ' ')}`;
}

export function transcriptionState(provider: string, baseUrl: string, apiKey: string): MemoTranscriptionState {
  if (provider === 'none') return { enabled: false, missing: 'TRANSCRIPTION_PROVIDER' };
  // gen-api's URL is fixed (#584); only the key is the operator's.
  if (provider === 'gen-api') return apiKey.trim() ? { enabled: true, missing: null } : { enabled: false, missing: 'TRANSCRIPTION_API_KEY' };
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
    source: row.source as MemoSource,
    type: row.type,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
