import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { apiSpecSyntaxOf } from '@knowledge/contracts';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
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
  /**
   * Signs the URLs a browser follows, and nothing else. SigV4 signs the Host,
   * so a URL signed for `minio:9000` cannot be repaired by rewriting its host
   * afterwards — it has to be signed for the public origin in the first place.
   * Presigning makes no network call, so this client never has to reach it.
   */
  private readonly presigner: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    const endpoint = config.get('S3_ENDPOINT', { infer: true });
    const publicEndpoint = config.get('S3_PUBLIC_ENDPOINT', { infer: true });
    const client = (url: string) =>
      new S3Client({
        endpoint: url,
        region: config.get('S3_REGION', { infer: true }),
        forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
        credentials: {
          accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }),
          secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }),
        },
      });
    this.s3 = client(endpoint);
    this.presigner = publicEndpoint ? client(publicEndpoint) : this.s3;
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

  /** A memo's audio (#551). Under the workspace prefix, so teardown's `purgePrefix` takes it. */
  memoObjectKey(workspaceId: string, memoId: string, name: string): string {
    return `workspaces/${workspaceId}/memos/${memoId}/${safeSegment(name)}`;
  }

  /**
   * Staged connector items (docs/features/26). Same reasoning as imports: the
   * markdown exists before any document does, and for a skipped item there will
   * never be one. Keeping it here rather than in the row is what stops a
   * 500-page space turning the row the UI polls into tens of megabytes.
   */
  connectorItemObjectKey(workspaceId: string, runId: string, itemId: string, filename: string): string {
    return `workspaces/${workspaceId}/connector-runs/${runId}/items/${itemId}/${safeSegment(filename)}`;
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
  /**
   * A revision's object name, from its content type (#78): `source.yaml` /
   * `source.json` for an API spec, `source.md` for everything else. Existing
   * rows keep the key they were written under — `s3_key` is stored, never
   * re-derived.
   */
  sourceObjectName(contentType: string): string {
    const t = contentType.toLowerCase();
    if (t.includes('markdown') || t.startsWith('text/plain')) return 'source.md';
    const syntax = apiSpecSyntaxOf(t);
    return syntax ? `source.${syntax}` : 'source.md';
  }

  revisionObjectKey(workspaceId: string, documentId: string, revisionId: string, filename: string): string {
    return `workspaces/${workspaceId}/documents/${documentId}/revisions/${revisionId}/${filename}`;
  }

  async presignPut(objectKey: string, contentType: string, expiresInSeconds = 900): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: contentType });
    return getSignedUrl(this.presigner, cmd, { expiresIn: expiresInSeconds });
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
    return getSignedUrl(this.presigner, cmd, { expiresIn: opts.expiresInSeconds ?? 900 });
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

  /** Streamed to disk, for a file too large to hold in memory (a memo's recording, #551). */
  async downloadToFile(objectKey: string, path: string): Promise<void> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    if (!res.Body) throw new Error(`Object ${objectKey} has no body`);
    await pipeline(res.Body as Readable, createWriteStream(path));
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
  }

  /**
   * Delete a key *and every version of it*.
   *
   * The bucket is versioned (`mc version enable` in docker-compose), which
   * makes an ordinary DeleteObject write a delete marker: the key stops
   * resolving, and every byte it ever held stays in the bucket. That is the
   * right default — it is what makes a revision's `s3VersionId` meaningful and
   * an accidental overwrite recoverable — but it is not a deletion, and a
   * cascade that reported "340 files deleted" while leaving all 340 on disk
   * would be reporting something untrue.
   *
   * So this lists the key's versions (delete markers included, or the marker
   * from a previous pass would be left behind) and removes them by id. Paged,
   * because ListObjectVersions caps at 1000 and a heavily revised page can
   * exceed that.
   */
  async purgeObjectVersions(objectKey: string): Promise<void> {
    // Prefix is a prefix, not an exact match: a sibling key that merely starts
    // with this one must not be swept up with it.
    await this.purgeVersions(objectKey, (key) => key === objectKey);
  }

  /** Every version of every key under `prefix` — a deleted workspace's whole tree (#479). */
  async purgePrefix(prefix: string): Promise<void> {
    await this.purgeVersions(prefix, () => true);
  }

  private async purgeVersions(prefix: string, matches: (key: string) => boolean): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const listed = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]
        .filter((v) => v.Key && matches(v.Key) && v.VersionId)
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId! }));
      if (objects.length > 0) {
        await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      keyMarker = listed.IsTruncated ? listed.NextKeyMarker : undefined;
      versionIdMarker = listed.IsTruncated ? listed.NextVersionIdMarker : undefined;
    } while (keyMarker || versionIdMarker);
  }

  /**
   * Keep the newest `keep` versions of a key and delete the rest — a key
   * rewritten on a schedule (a draft checkpoint) is its own history in the
   * versioned bucket, and this is its retention.
   */
  async pruneObjectVersions(objectKey: string, keep: number): Promise<void> {
    // ponytail: one page (1000 versions); a key rewritten more often than it is pruned would need paging.
    const listed = await this.s3.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: objectKey }));
    // Listed newest first, so everything past `keep` is older.
    const old = (listed.Versions ?? [])
      .filter((v) => v.Key === objectKey && v.VersionId)
      .slice(keep)
      .map((v) => ({ Key: v.Key!, VersionId: v.VersionId! }));
    if (old.length > 0) {
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: old, Quiet: true } }));
    }
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
