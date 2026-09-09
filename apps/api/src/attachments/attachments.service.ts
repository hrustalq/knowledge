import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AttachmentStatus,
  AttachmentSummary,
  CompleteAttachmentResponse,
  CreateAttachmentResponse,
  ListAttachmentsResponse,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { t } from '../i18n/t.js';

/** Author fallback for the AUTH_MODE=none dev principal, same stub the rest of the API uses. */
const AUTHOR_ID_STUB = '00000000-0000-0000-0000-000000000000';

/**
 * Types the browser may render in-place. Everything else is served as a
 * download: an uploaded file must never choose to execute in the app's context,
 * so disposition is decided here, not by the object's own metadata.
 */
const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
]);

interface AttachmentRow {
  id: string;
  workspaceId: string;
  documentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  s3Key: string;
  status: string;
  uploadedBy: string;
  createdAt: Date;
}

@Injectable()
export class AttachmentsService {
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly activity: ActivityService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('ATTACHMENT_MAX_BYTES', { infer: true });
  }

  /**
   * Step 1: reserve the row and hand back a presigned PUT. The row exists
   * before the bytes do so the editor can insert the embed optimistically and
   * the object key is never guessed client-side.
   */
  async create(
    documentId: string,
    dto: { filename: string; contentType: string; sizeBytes?: number },
    userId?: string,
  ): Promise<CreateAttachmentResponse> {
    if (dto.sizeBytes !== undefined && dto.sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException(t('error.attachment.tooLarge', { limit: this.maxBytes }));
    }
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, workspaceId: true },
    });
    if (!document) throw new NotFoundException(t('error.attachment.documentNotFound'));

    const attachmentId = crypto.randomUUID();
    const s3Key = this.storage.attachmentObjectKey(
      document.workspaceId,
      document.id,
      attachmentId,
      dto.filename,
    );
    const row = await this.prisma.attachment.create({
      data: {
        id: attachmentId,
        workspaceId: document.workspaceId,
        documentId: document.id,
        filename: dto.filename,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes ?? 0,
        s3Key,
        status: 'pending',
        uploadedBy: userId ?? AUTHOR_ID_STUB,
      },
    });

    const expiresInSeconds = 900;
    const url = await this.storage.presignPut(s3Key, dto.contentType, expiresInSeconds);
    return {
      attachment: this.toSummary(row),
      upload: {
        url,
        method: 'PUT',
        headers: { 'Content-Type': dto.contentType },
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      },
    };
  }

  /**
   * Step 2: confirm the object landed. Size comes from the bucket, not from the
   * client, and a missing object keeps the row `pending` rather than producing
   * an embed that renders as a broken image forever.
   */
  async complete(documentId: string, attachmentId: string): Promise<CompleteAttachmentResponse> {
    const row = await this.require(documentId, attachmentId);
    const head = await this.storage.headObject(row.s3Key);
    if (!head) throw new BadRequestException(t('error.attachment.uploadMissing'));
    if (head.contentLength > this.maxBytes) {
      await this.storage.deleteObject(row.s3Key);
      await this.prisma.attachment.delete({ where: { id: row.id } });
      throw new PayloadTooLargeException(t('error.attachment.tooLarge', { limit: this.maxBytes }));
    }
    const updated = await this.prisma.attachment.update({
      where: { id: row.id },
      data: { status: 'ready', sizeBytes: head.contentLength },
    });
    void this.activity.record({
      workspaceId: row.workspaceId,
      action: 'attachment.created',
      documentId: row.documentId,
      subjectId: row.documentId,
      metadata: { attachmentId: row.id, filename: row.filename, contentType: row.contentType },
    });
    return { attachment: this.toSummary(updated) };
  }

  async list(documentId: string): Promise<ListAttachmentsResponse> {
    const rows = await this.prisma.attachment.findMany({
      where: { documentId, status: 'ready' },
      orderBy: { createdAt: 'desc' },
    });
    return { attachments: rows.map((r) => this.toSummary(r)) };
  }

  /** Presigned read URL the controller redirects to. */
  async readUrl(documentId: string, attachmentId: string, download: boolean): Promise<string> {
    const row = await this.require(documentId, attachmentId);
    return this.storage.presignGet(row.s3Key, {
      filename: row.filename,
      contentType: row.contentType,
      disposition: !download && INLINE_TYPES.has(row.contentType) ? 'inline' : 'attachment',
    });
  }

  async remove(documentId: string, attachmentId: string): Promise<{ deleted: true }> {
    const row = await this.require(documentId, attachmentId);
    await this.storage.deleteObject(row.s3Key);
    await this.prisma.attachment.delete({ where: { id: row.id } });
    void this.activity.record({
      workspaceId: row.workspaceId,
      action: 'attachment.deleted',
      documentId: row.documentId,
      subjectId: row.documentId,
      metadata: { attachmentId: row.id, filename: row.filename },
    });
    return { deleted: true };
  }

  private async require(documentId: string, attachmentId: string): Promise<AttachmentRow> {
    const row = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    // Scoped by document on purpose: the ACL guard authorized *this* document,
    // so an attachment id belonging to another page must not resolve here.
    if (!row || row.documentId !== documentId) throw new NotFoundException(t('error.attachment.notFound'));
    return row;
  }

  private toSummary(row: AttachmentRow): AttachmentSummary {
    return {
      attachmentId: row.id,
      documentId: row.documentId,
      filename: row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      status: row.status as AttachmentStatus,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(),
      url: `/v1/documents/${row.documentId}/attachments/${row.id}/content`,
    };
  }
}
