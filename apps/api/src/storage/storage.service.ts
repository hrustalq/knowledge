import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
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
    return `workspaces/${workspaceId}/documents/${documentId}/attachments/${attachmentId}/${safeSegment(filename)}`;
  }

  /**
   * Import staging (docs/features/16). Not under a document prefix, because at
   * upload time there is no document — and there may never be one, since an
   * import can be abandoned at the review step.
   */
  importObjectKey(workspaceId: string, importId: string, filename: string): string {
    return `workspaces/${workspaceId}/imports/${importId}/${safeSegment(filename)}`;
  }

  /**
   * Avatars (docs/features/23). Deliberately outside the `workspaces/` tree
   * that every other key sits under: a user belongs to several workspaces and a
   * face does not change between them, so filing it under one would make the
   * others read a foreign tenant's prefix. Projects follow the same layout for
   * symmetry — one place to look for a picture of a thing.
   *
   * The upload id is a path segment, so replacing an avatar writes a new object
   * rather than overwriting a live one. That matters because the old URL may be
   * mid-flight in a browser; the row moves to the new key and the old object is
   * deleted after, not under, whoever is still reading it.
   */
  avatarObjectKey(kind: 'users' | 'projects', ownerId: string, uploadId: string, filename: string): string {
    return `avatars/${kind}/${ownerId}/${uploadId}/${safeSegment(filename)}`;
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

  /**
   * Server-side copy, so promoting an import's staged original into the new
   * page's attachments never pulls a 50 MB PDF through Node just to push it
   * back. Source and destination are both keys in this bucket.
   */
  async copyObject(fromKey: string, toKey: string, contentType?: string): Promise<void> {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${fromKey}`,
        Key: toKey,
        ...(contentType ? { ContentType: contentType, MetadataDirective: 'REPLACE' as const } : {}),
      }),
    );
  }

  async putObjectBytes(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, Body: body, ContentType: contentType }),
    );
  }

  async getObjectBytes(objectKey: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    return (await res.Body?.transformToByteArray()) ?? new Uint8Array();
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

/**
 * A user-supplied filename reduced to one safe path segment. Slashes and every
 * other separator are folded away, so a name can never climb out of the prefix
 * it was given, and the tail is kept because that is where the extension is.
 */
function safeSegment(filename: string): string {
  return filename.replace(/[^\w.-]+/g, '_').slice(-120) || 'file';
}
