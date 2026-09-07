import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';

export interface HeadResult {
  contentLength: number;
  versionId: string | null;
  contentType: string | null;
}

@Injectable()
export class StorageService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.s3 = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
      },
    });
  }

  /**
   * Attachment key layout: same document prefix as revisions, a sibling
   * namespace. The id is part of the path so two uploads of `diagram.png`
   * cannot collide, and the original filename is kept as the last segment so
   * anything browsing the bucket still sees readable names.
   */
  attachmentObjectKey(workspaceId: string, documentId: string, attachmentId: string, filename: string): string {
    const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';
    return `workspaces/${workspaceId}/documents/${documentId}/attachments/${attachmentId}/${safe}`;
  }

  /** Object key layout per plan.md §4. */
  revisionObjectKey(workspaceId: string, documentId: string, revisionId: string, filename: string): string {
    return `workspaces/${workspaceId}/documents/${documentId}/revisions/${revisionId}/${filename}`;
  }

  async presignPut(objectKey: string, contentType: string, expiresInSeconds = 900): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: contentType });
    return getSignedUrl(this.s3, cmd, { expiresIn: expiresInSeconds });
  }

  /**
   * Read URL handed to the browser. `<img>` and `<object>` cannot send an
   * Authorization header, so the API authorizes the request and then redirects
   * here rather than proxying the bytes through Node.
   *
   * Disposition is forced rather than inherited: an uploaded file must never be
   * able to decide it renders inline in the app's context.
   */
  async presignGet(
    objectKey: string,
    opts: { filename: string; contentType: string; disposition: 'inline' | 'attachment'; expiresInSeconds?: number },
  ): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: `${opts.disposition}; filename="${opts.filename.replace(/["\\]/g, '')}"`,
    });
    return getSignedUrl(this.s3, cmd, { expiresIn: opts.expiresInSeconds ?? 900 });
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  async headObject(objectKey: string): Promise<HeadResult | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return {
        contentLength: res.ContentLength ?? 0,
        versionId: res.VersionId ?? null,
        contentType: res.ContentType ?? null,
      };
    } catch (e: unknown) {
      if ((e as { name?: string }).name === 'NotFound') return null;
      throw e;
    }
  }

  async getObjectText(objectKey: string): Promise<string> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    return (await res.Body?.transformToString('utf-8')) ?? '';
  }

  async putObjectText(objectKey: string, body: string, contentType: string): Promise<string | null> {
    const res = await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: body, ContentType: contentType }),
    );
    return res.VersionId ?? null;
  }

  async putObjectJson(objectKey: string, value: unknown): Promise<string | null> {
    return this.putObjectText(objectKey, JSON.stringify(value, null, 2), 'application/json');
  }
}
