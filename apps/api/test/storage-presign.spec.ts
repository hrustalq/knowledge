import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import * as storageModule from '../src/storage/storage.service.js';
import { StorageService } from '../src/storage/storage.service.js';

// Looked up at call time, so the red run fails on behaviour rather than on a missing export.
const ObjectTooLargeError = (storageModule as Record<string, unknown>).ObjectTooLargeError as new (...a: never[]) => Error;
import type { Env } from '../src/config/env.js';

/**
 * Presigned URLs (#144). Production reaches MinIO at `http://minio:9000`, a
 * name only the Docker network resolves, so the URLs a browser follows must be
 * signed for S3_PUBLIC_ENDPOINT — and with it unset, nothing changes.
 * Presigning is local: no MinIO is needed to run this.
 */
function storage(publicEndpoint: string): StorageService {
  const env: Partial<Env> = {
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_ENDPOINT: publicEndpoint,
    S3_REGION: 'us-east-1',
    S3_ACCESS_KEY: 'test-access',
    S3_SECRET_KEY: 'test-secret',
    S3_BUCKET: 'knowledge',
    S3_FORCE_PATH_STYLE: true,
    REVISION_MAX_BYTES: 52_428_800,
  };
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  return new StorageService(config);
}

const KEY = 'avatars/users/u1/up1/me.png';

describe('StorageService presigning', () => {
  it('signs browser URLs for the public endpoint, path-style under the bucket', async () => {
    const s = storage('https://knowledge.example.dev');
    const put = new URL(await s.presignPut(KEY, 'image/png'));
    const get = new URL(
      await s.presignGet(KEY, { filename: 'me.png', contentType: 'image/png', disposition: 'inline' }),
    );
    for (const url of [put, get]) {
      expect(url.origin).toBe('https://knowledge.example.dev');
      expect(url.pathname).toBe(`/knowledge/${KEY}`);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host');
    }
  });

  it('falls back to S3_ENDPOINT when the public endpoint is unset', async () => {
    const url = new URL(await storage('').presignPut(KEY, 'image/png'));
    expect(url.origin).toBe('http://minio:9000');
  });
});

describe('StorageService.getObjectVersion ceiling (#1109)', () => {
  function withObject(contentLength: number) {
    const s = storage('');
    const body = { transformToString: vi.fn(async () => 'x'.repeat(contentLength)), destroy: vi.fn() };
    (s as unknown as { s3: { send: unknown } }).s3 = { send: vi.fn(async () => ({ ContentLength: contentLength, VersionId: 'v1', Body: body })) };
    return { s, body };
  }

  it('refuses an object over the revision ceiling from its length, before reading the body', async () => {
    const { s, body } = withObject(60 * 1024 * 1024);
    await expect(s.getObjectVersion('k')).rejects.toBeInstanceOf(ObjectTooLargeError);
    expect(body.transformToString).not.toHaveBeenCalled();
    expect(body.destroy).toHaveBeenCalled();
  });

  it('reads one under it', async () => {
    const { s } = withObject(10);
    expect(await s.getObjectVersion('k')).toEqual({ text: 'x'.repeat(10), versionId: 'v1' });
  });
});
