import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AvatarsService } from '../src/avatars/avatars.service.js';

/** An avatar is a picture because the stored object says so, not because the upload's first step did. */
describe('avatar content types', () => {
  function service(storedType: string | null) {
    const storage = {
      avatarObjectKey: () => 'k',
      presignPut: vi.fn(async () => 'https://put'),
      headObject: vi.fn(async () => ({ contentLength: 10, versionId: null, contentType: storedType })),
      deleteObject: vi.fn(async () => undefined),
      presignGet: vi.fn(async () => 'https://get'),
    };
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ avatarKey: 'k' })), update: vi.fn(async () => ({})) },
      $transaction: vi.fn(),
    };
    return { svc: new AvatarsService(prisma as never, storage as never), storage, prisma };
  }

  it('binds the declared type into the upload URL', async () => {
    const { svc, storage } = service(null);
    await svc.reserve('users', 'u1', { filename: 'me.png', contentType: 'image/png', sizeBytes: 10 } as never);
    expect(storage.presignPut).toHaveBeenCalledWith('k', 'image/png', 900, { bindContentType: true });
  });

  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', null])('refuses and deletes an upload that arrived as %s', async (type) => {
    const { svc, storage, prisma } = service(type);
    await expect(svc.complete('users', 'u1', 'me.png', 'up1')).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.deleteObject).toHaveBeenCalledWith('k');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('serves an allowlisted type inline', async () => {
    const { svc, storage } = service('image/png');
    expect(await svc.presignedGet('users', 'u1')).toBe('https://get');
    expect(storage.presignGet).toHaveBeenCalledWith('k', expect.objectContaining({ contentType: 'image/png', disposition: 'inline' }));
  });

  it.each(['text/html', null])('treats a stored %s as no picture at all', async (type) => {
    const { svc, storage } = service(type);
    await expect(svc.presignedGet('users', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.presignGet).not.toHaveBeenCalled();
  });
});
