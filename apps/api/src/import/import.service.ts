import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type ImportJob } from '@prisma/client';
import {
  IMPORT_FORMATS,
  importFormatFor,
  type CreateImportResponse,
  type DocumentCategory,
  type ImportContentResponse,
  type ImportJobInfo,
  type ImportMeta,
  type ImportParserId,
  type ImportStatus,
  type SubmitImportResponse,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { ImportProducer } from './import.producer.js';
import type { CreateImportDto, SubmitImportDto } from './dto/imports.dto.js';
import { t } from '../i18n/t.js';
import { currentLocale } from '../i18n/locale.js';

/** Author fallback in AUTH_MODE=none, the same stub the rest of the API uses. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/** Staged images the parser produced, referenced from the parsed markdown. */
const STAGED_IMAGE_RE = /\/v1\/imports\/([0-9a-f-]{36})\/images\/(\d+)/g;

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly projects: ProjectsService,
    private readonly documents: DocumentsService,
    private readonly activity: ActivityService,
    private readonly producer: ImportProducer,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('IMPORT_MAX_BYTES', { infer: true });
  }

  /**
   * Step 1: reserve the row and hand back a presigned PUT.
   *
   * Both refusals that matter happen here rather than after the upload — being
   * told a 40 MB file is the wrong type once it has finished uploading is the
   * single rudest thing an import flow can do.
   */
  async create(dto: CreateImportDto, userId?: string): Promise<CreateImportResponse> {
    const format = importFormatFor(dto.filename, dto.contentType);
    if (!format) {
      throw new UnsupportedMediaTypeException(
        t('error.import.unsupportedFormat', {
          filename: dto.filename,
          accepted: IMPORT_FORMATS.map((f) => f.extensions.join(', ')).join(', '),
        }),
      );
    }
    if (dto.sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException(
        t('error.import.tooLarge', { size: formatBytes(dto.sizeBytes), limit: formatBytes(this.maxBytes) }),
      );
    }
    await this.projects.requireProjectInWorkspace(dto.projectId, dto.workspaceId);
    if (dto.parentId) await this.requireParent(dto.parentId, dto.projectId);

    const row = await this.prisma.importJob.create({
      data: {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        parentId: dto.parentId ?? null,
        category: dto.category ?? 'other',
        sourceFilename: dto.filename,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
        // Placeholder: the key needs the row id, which the insert just minted.
        s3Key: '',
        createdBy: userId ?? AUTHOR_ID_STUB,
        // Frozen here: the parse runs in a worker minutes later, with no
        // request left to read a language from (docs/features/18).
        locale: currentLocale(),
      },
    });

    const s3Key = this.storage.importObjectKey(row.workspaceId, row.id, dto.filename);
    const updated = await this.prisma.importJob.update({ where: { id: row.id }, data: { s3Key } });
    const url = await this.storage.presignPut(s3Key, dto.contentType);

    return {
      import: toInfo(updated),
      upload: {
        url,
        method: 'PUT',
        headers: { 'Content-Type': dto.contentType },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      },
    };
  }

  /**
   * Step 2: the bytes are up — queue the parse.
   *
   * The size is re-read from the bucket rather than trusted from the client,
   * the same guard `AttachmentsService.complete` applies: a presigned PUT is a
   * capability, and a capability that only checks the claimed size checks
   * nothing.
   */
  async start(importId: string): Promise<ImportJobInfo> {
    const row = await this.require(importId);
    if (row.status === 'running' || row.status === 'queued') return toInfo(row);
    if (row.status === 'submitted') {
      throw new ConflictException(t('error.import.alreadySubmitted'));
    }

    const head = await this.storage.headObject(row.s3Key);
    if (!head) throw new BadRequestException(t('error.import.uploadMissing'));
    if (head.contentLength > this.maxBytes) {
      await this.discard(importId);
      throw new PayloadTooLargeException(
        t('error.import.tooLarge', { size: formatBytes(head.contentLength), limit: formatBytes(this.maxBytes) }),
      );
    }

    const updated = await this.prisma.importJob.update({
      where: { id: row.id },
      data: {
        status: 'queued',
        sizeBytes: head.contentLength,
        stage: 'Queued',
        progress: null,
        error: Prisma.DbNull,
      },
    });
    await this.producer.enqueue(row.id);
    return toInfo(updated);
  }

  async get(importId: string): Promise<ImportJobInfo> {
    return toInfo(await this.require(importId));
  }

  /** The parsed markdown, read once at the point the review step opens. */
  async content(importId: string): Promise<ImportContentResponse> {
    const row = await this.require(importId);
    if (row.status !== 'parsed' && row.status !== 'submitted') {
      throw new ConflictException(t('error.import.notReviewable', { status: t(`status.import.${row.status}`) }));
    }
    const markdown = await this.storage.getObjectText(
      this.storage.importObjectKey(row.workspaceId, row.id, 'parsed.md'),
    );
    return {
      importId: row.id,
      title: row.title,
      markdown,
      warnings: readWarnings(row.warnings),
      meta: readMeta(row.meta),
    };
  }

  /** Presigned read for a staged image, so the review step shows the real picture. */
  async imageUrl(importId: string, index: number): Promise<string> {
    const row = await this.require(importId);
    const prefix = this.storage.importObjectKey(row.workspaceId, row.id, `images/${index}`);
    // The extension is part of the key, so the exact object is found by probing
    // the handful of types a parser can emit rather than by listing the bucket.
    for (const ext of ['.png', '.jpg', '.gif', '.webp', '.bmp', '.tiff', '.emf', '.wmf', '.bin']) {
      const key = `${prefix}${ext}`;
      const head = await this.storage.headObject(key);
      if (head) {
        return this.storage.presignGet(key, {
          filename: `image-${index}${ext}`,
          contentType: head.contentType ?? 'application/octet-stream',
          disposition: 'inline',
        });
      }
    }
    throw new NotFoundException(t('error.import.imageNotFound', { index, importId }));
  }

  /**
   * Step 3: become a page.
   *
   * One call rather than the four the old upload page made from the browser
   * (create → presign → PUT → finalize), because everything here has to happen
   * together: the page, the original file attached to it, and the staged
   * markdown's image links rewritten to point at those attachments. A client
   * doing this in pieces would leave a page with broken images every time a
   * step failed halfway.
   */
  async submit(importId: string, dto: SubmitImportDto, userId?: string): Promise<SubmitImportResponse> {
    const row = await this.require(importId);
    if (row.status === 'submitted') {
      throw new ConflictException(t('error.import.alreadySubmitted'));
    }
    if (row.status !== 'parsed') {
      throw new ConflictException(t('error.import.notSubmittable', { status: t(`status.import.${row.status}`) }));
    }

    const projectId = dto.projectId ?? row.projectId;
    await this.projects.requireProjectInWorkspace(projectId, row.workspaceId);
    const parentId = dto.parentId === undefined ? row.parentId : dto.parentId;
    if (parentId) await this.requireParent(parentId, projectId);

    // Deliberately created *without* inline content: attachments need a
    // document id, and the markdown needs their ids back before it is written.
    // Creating the draft, promoting the files, then writing once means the page
    // has exactly one revision whose image links have always worked — rather
    // than a first revision full of dead links and a second one fixing them.
    const created = await this.documents.createDocument(
      {
        workspaceId: row.workspaceId,
        projectId,
        title: dto.title.trim() || row.sourceFilename,
        category: (dto.category ?? row.category) as DocumentCategory,
        ...(parentId ? { parentId } : {}),
      },
      userId,
    );

    // The original comes across as an attachment so the page carries its own
    // provenance: where a claim came from is worth as much as the claim.
    const attachmentId = await this.promoteOriginal(row, created.documentId, userId).catch((e: unknown) => {
      this.logger.warn(`Original not attached for import ${row.id}: ${(e as Error).message}`);
      return null;
    });

    const markdown = await this.promoteImages(row, created.documentId, dto.markdown, userId);
    const revision = await this.prisma.documentRevision.findUnique({ where: { id: created.revisionId } });
    if (!revision) throw new NotFoundException(t('error.import.revisionVanished', { id: created.revisionId }));
    await this.storage.putObjectText(revision.s3Key, markdown, 'text/markdown');
    const finalized = await this.documents.finalizeRevision(created.documentId, created.revisionId);

    await this.prisma.importJob.update({
      where: { id: row.id },
      data: { status: 'submitted', documentId: created.documentId, completedAt: new Date() },
    });

    void this.activity.record({
      workspaceId: row.workspaceId,
      action: 'import.submitted',
      documentId: created.documentId,
      subjectId: created.documentId,
      metadata: { filename: row.sourceFilename, parser: row.parser, title: dto.title },
    });

    // Staging is cleared once the page owns everything worth keeping.
    void this.cleanup(row).catch(() => undefined);

    return { documentId: created.documentId, revisionId: finalized.revisionId, attachmentId };
  }

  /** Abandoning at the review step is a normal outcome, not an error. */
  async discard(importId: string): Promise<{ deleted: true }> {
    const row = await this.require(importId);
    await this.cleanup(row).catch(() => undefined);
    await this.prisma.importJob.delete({ where: { id: row.id } });
    return { deleted: true };
  }

  // --- internals ------------------------------------------------------------

  private async require(importId: string): Promise<ImportJob> {
    const row = await this.prisma.importJob.findUnique({ where: { id: importId } });
    if (!row) throw new NotFoundException(t('error.import.notFound', { id: importId }));
    return row;
  }

  private async requireParent(parentId: string, projectId: string): Promise<void> {
    const parent = await this.prisma.document.findUnique({ where: { id: parentId } });
    if (!parent || parent.projectId !== projectId) {
      throw new BadRequestException(t('error.import.parentNotInProject', { id: parentId }));
    }
  }

  private async promoteOriginal(row: ImportJob, documentId: string, userId?: string): Promise<string> {
    const attachment = await this.prisma.attachment.create({
      data: {
        workspaceId: row.workspaceId,
        documentId,
        filename: row.sourceFilename,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        s3Key: '',
        status: 'pending',
        uploadedBy: userId ?? AUTHOR_ID_STUB,
      },
    });
    const key = this.storage.attachmentObjectKey(row.workspaceId, documentId, attachment.id, row.sourceFilename);
    await this.storage.copyObject(row.s3Key, key, row.contentType);
    await this.prisma.attachment.update({
      where: { id: attachment.id },
      data: { s3Key: key, status: 'ready' },
    });
    return attachment.id;
  }

  /**
   * Every `/v1/imports/:id/images/:n` the markdown still points at becomes a
   * real attachment on the page. Only the links actually present survive — an
   * image the reviewer deleted from the draft should not arrive anyway.
   */
  private async promoteImages(
    row: ImportJob,
    documentId: string,
    markdown: string,
    userId?: string,
  ): Promise<string> {
    const referenced = [...markdown.matchAll(STAGED_IMAGE_RE)]
      .filter((m) => m[1] === row.id)
      .map((m) => Number(m[2]));
    const indices = [...new Set(referenced)];
    if (indices.length === 0) return markdown;

    const replacements = new Map<number, string>();
    for (const index of indices) {
      try {
        const source = await this.findImageKey(row, index);
        if (!source) continue;
        const head = await this.storage.headObject(source.key);
        const attachment = await this.prisma.attachment.create({
          data: {
            workspaceId: row.workspaceId,
            documentId,
            filename: source.filename,
            contentType: head?.contentType ?? 'application/octet-stream',
            sizeBytes: head?.contentLength ?? 0,
            s3Key: '',
            status: 'pending',
            uploadedBy: userId ?? AUTHOR_ID_STUB,
          },
        });
        const key = this.storage.attachmentObjectKey(row.workspaceId, documentId, attachment.id, source.filename);
        await this.storage.copyObject(source.key, key, head?.contentType ?? undefined);
        await this.prisma.attachment.update({
          where: { id: attachment.id },
          data: { s3Key: key, status: 'ready' },
        });
        replacements.set(index, `/v1/documents/${documentId}/attachments/${attachment.id}/content`);
      } catch (e) {
        this.logger.warn(`Image ${index} of import ${row.id} not promoted: ${(e as Error).message}`);
      }
    }

    return markdown.replace(STAGED_IMAGE_RE, (match, id: string, n: string) =>
      id === row.id ? (replacements.get(Number(n)) ?? match) : match,
    );
  }

  private async findImageKey(row: ImportJob, index: number): Promise<{ key: string; filename: string } | null> {
    const prefix = this.storage.importObjectKey(row.workspaceId, row.id, `images/${index}`);
    for (const ext of ['.png', '.jpg', '.gif', '.webp', '.bmp', '.tiff', '.emf', '.wmf', '.bin']) {
      const key = `${prefix}${ext}`;
      if (await this.storage.headObject(key)) return { key, filename: `image-${index + 1}${ext}` };
    }
    return null;
  }

  private async cleanup(row: ImportJob): Promise<void> {
    const keys = [row.s3Key, this.storage.importObjectKey(row.workspaceId, row.id, 'parsed.md')];
    const meta = readMeta(row.meta);
    for (let i = 0; i < (meta.images ?? 0); i++) {
      const found = await this.findImageKey(row, i);
      if (found) keys.push(found.key);
    }
    for (const key of keys) {
      if (key) await this.storage.deleteObject(key).catch(() => undefined);
    }
  }
}

function toInfo(row: ImportJob): ImportJobInfo {
  return {
    importId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    parentId: row.parentId,
    category: row.category as DocumentCategory,
    status: row.status as ImportStatus,
    stage: row.stage,
    progress: row.progress,
    sourceFilename: row.sourceFilename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    parser: (row.parser as ImportParserId | null) ?? null,
    title: row.title,
    warnings: readWarnings(row.warnings),
    meta: readMeta(row.meta),
    error: readError(row.error),
    documentId: row.documentId,
    createdAt: row.createdAt.toISOString(),
  };
}

function readWarnings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function readMeta(value: unknown): ImportMeta {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ImportMeta) : {};
}

function readError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
