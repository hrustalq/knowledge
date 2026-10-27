import { describe, expect, it, vi } from 'vitest';
import { NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { memoExtensionFor } from '@knowledge/contracts';
import { MemosService, transcriptionState } from '../src/memos/memos.service.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Memos (#551): what is pinned here is the door — which files are taken, that
 * a server with no speech endpoint refuses before handing out a URL, and that
 * a memo is read only by its uploader (a 404 for anyone else, admins aside).
 */
describe('memoExtensionFor', () => {
  it('takes the extension first, the content type as the fallback', () => {
    expect(memoExtensionFor('Daily 27.10.M4A', 'application/octet-stream')).toBe('.m4a');
    expect(memoExtensionFor('recording', 'audio/mpeg; charset=binary')).toBe('.mp3');
    expect(memoExtensionFor('call.wav', '')).toBe('.wav');
  });

  it('refuses what is not audio memos take', () => {
    expect(memoExtensionFor('talk.mp4', 'video/mp4')).toBeNull();
    expect(memoExtensionFor('notes.txt', 'text/plain')).toBeNull();
  });
});

describe('transcriptionState', () => {
  it('names the variable that is missing', () => {
    expect(transcriptionState('none', 'http://x')).toEqual({ enabled: false, missing: 'TRANSCRIPTION_PROVIDER' });
    expect(transcriptionState('openai-compatible', ' ')).toEqual({ enabled: false, missing: 'TRANSCRIPTION_BASE_URL' });
    expect(transcriptionState('openai-compatible', 'http://x')).toEqual({ enabled: true, missing: null });
  });
});

describe('MemosService', () => {
  const env: Record<string, unknown> = {
    MEMO_MAX_BYTES: 1000,
    MEMO_MAX_MINUTES: 1,
    TRANSCRIPTION_PROVIDER: 'openai-compatible',
    TRANSCRIPTION_BASE_URL: 'http://stt',
  };
  const member = { userId: 'u1', isAdmin: false } as Principal;

  function service(overrides: Record<string, unknown> = {}) {
    const prisma = { memo: { findFirst: vi.fn().mockResolvedValue(null) } };
    const config = { get: (key: string) => ({ ...env, ...overrides })[key] };
    return {
      prisma,
      memos: new MemosService(prisma as never, {} as never, {} as never, {} as never, config as never),
    };
  }

  it('reads a memo only through its uploader, and answers anyone else with a bare 404', async () => {
    const { prisma, memos } = service();
    await expect(memos.get(member, 'm1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.memo.findFirst).toHaveBeenCalledWith({ where: { id: 'm1', createdBy: 'u1' } });

    await memos.get({ userId: 'admin', isAdmin: true } as Principal, 'm1').catch(() => undefined);
    expect(prisma.memo.findFirst).toHaveBeenLastCalledWith({ where: { id: 'm1' } });
  });

  it('refuses to reserve when this server cannot transcribe, naming what to set', async () => {
    const { memos } = service({ TRANSCRIPTION_PROVIDER: 'none' });
    const refused = await memos
      .create(member, { workspaceId: 'w', projectId: 'p', filename: 'a.mp3', contentType: 'audio/mpeg', sizeBytes: 10 })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ServiceUnavailableException);
    expect((refused as ServiceUnavailableException).getResponse()).toMatchObject({ missing: 'TRANSCRIPTION_PROVIDER' });
  });

  it('refuses a recording the browser says is longer than the ceiling, before any upload', async () => {
    const { memos } = service();
    await expect(
      memos.create(member, {
        workspaceId: 'w',
        projectId: 'p',
        filename: 'a.mp3',
        contentType: 'audio/mpeg',
        sizeBytes: 10,
        durationSeconds: 61,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});
