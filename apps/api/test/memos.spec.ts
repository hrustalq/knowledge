import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { memoExtensionFor } from '@knowledge/contracts';
import { MemosService, transcriptionState } from '../src/memos/memos.service.js';
import type { Principal } from '../src/auth/principal.js';
import { stitchTranscript } from '../src/memos/transcript.js';
import { MemoRetentionSweeper } from '../src/memos/memo-retention.sweeper.js';

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
      memos: new MemosService(prisma as never, {} as never, {} as never, {} as never, {} as never, config as never),
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

describe('stitchTranscript', () => {
  it('shifts each chunk by its offset, numbers segments across chunks and drops silence', () => {
    const { segments, language } = stitchTranscript([
      { offset: 0, duration: 600, language: 'russian', text: '', segments: [{ start: 1.234, end: 4, text: ' Привет ' }, { start: 4, end: 5, text: '  ' }] },
      { offset: 600, duration: 30, language: 'english', text: '', segments: [{ start: 2, end: 6.5, text: 'Ship it on Friday.' }] },
    ]);
    expect(segments).toEqual([
      { i: 0, start: 1.23, end: 4, text: 'Привет' },
      { i: 1, start: 602, end: 606.5, text: 'Ship it on Friday.' },
    ]);
    expect(language).toBe('russian');
  });

  it('keeps a chunk the server answered without segments as one span', () => {
    const { segments } = stitchTranscript([{ offset: 1200, duration: 42, language: null, text: 'Только текст', segments: [] }]);
    expect(segments).toEqual([{ i: 0, start: 1200, end: 1242, text: 'Только текст' }]);
  });

  it('masks a secret or an address before it is stored, with one placeholder per value across segments', () => {
    const { segments } = stitchTranscript([
      {
        offset: 0,
        duration: 60,
        language: 'english',
        text: '',
        segments: [
          { start: 0, end: 5, text: 'Write to anna@example.com about it' },
          { start: 5, end: 9, text: 'the key is ghp_0123456789abcdefghijABCDEFGHIJ012345' },
          { start: 9, end: 12, text: 'and cc anna@example.com again' },
        ],
      },
    ]);
    expect(segments.map((s) => s.text)).toEqual([
      'Write to [EMAIL_1] about it',
      'the key is [SECRET_1]',
      'and cc [EMAIL_1] again',
    ]);
  });
});

describe('MemoRetentionSweeper', () => {
  function sweeper(days: number) {
    const purged: string[] = []
    const prisma = {
      memo: {
        findMany: vi.fn(async ({ where }: { where: { status: unknown } }) =>
          where.status === 'pending' ? [{ id: 'p1', audioKey: 'k/p1' }] : [{ id: 'd1', audioKey: 'k/d1' }],
        ),
        update: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
    }
    const storage = { purgeObjectVersions: vi.fn(async (key: string) => void purged.push(key)) }
    const config = { get: () => days }
    return { prisma, purged, run: new MemoRetentionSweeper(prisma as never, storage as never, config as never) }
  }

  it('purges every version of settled audio past retention, keeps the transcript, and drops stale reservations', async () => {
    const { prisma, purged, run } = sweeper(30)
    const now = new Date('2026-12-01T00:00:00Z')
    await run.sweep(now)
    const settled = prisma.memo.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }
    expect(settled.where).toMatchObject({ audioPurgedAt: null, status: { in: ['done', 'failed'] } })
    expect(purged).toEqual(['k/d1', 'k/p1'])
    expect(prisma.memo.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { audioPurgedAt: now } })
    expect(prisma.memo.deleteMany).toHaveBeenCalledWith({ where: { id: 'p1', status: 'pending' } })
  })

  it('keeps audio forever at 0 days, but still clears abandoned reservations', async () => {
    const { prisma, purged, run } = sweeper(0)
    await run.sweep()
    expect(prisma.memo.update).not.toHaveBeenCalled()
    expect(purged).toEqual(['k/p1'])
  })
})

describe('MemosService.retry', () => {
  function service(row: Record<string, unknown>, claimed = 1) {
    const prisma = {
      memo: { findFirst: vi.fn(async () => row), updateMany: vi.fn(async () => ({ count: claimed })) },
    }
    const producer = { enqueue: vi.fn(async () => undefined) }
    const config = { get: (k: string) => ({ MEMO_MAX_BYTES: 1, MEMO_MAX_MINUTES: 1, TRANSCRIPTION_PROVIDER: 'openai-compatible', TRANSCRIPTION_BASE_URL: 'http://stt' })[k] }
    return { prisma, producer, memos: new MemosService(prisma as never, {} as never, {} as never, {} as never, producer as never, config as never) }
  }
  const base = { id: 'm1', status: 'failed', createdBy: 'u1', audioPurgedAt: null, createdAt: new Date(), updatedAt: new Date() }

  it('re-reads a memo that has its transcript, and re-transcribes one that has none', async () => {
    const withTranscript = service({ ...base, transcript: [{ i: 0, start: 0, end: 1, text: 'x' }] })
    await withTranscript.memos.retry({ userId: 'u1', isAdmin: false } as Principal, 'm1')
    expect(withTranscript.prisma.memo.updateMany.mock.calls[0]![0]).toMatchObject({ where: { status: 'failed' }, data: { status: 'transcribed' } })
    expect(withTranscript.producer.enqueue).toHaveBeenCalledWith('m1')

    const bare = service({ ...base, transcript: null })
    await bare.memos.retry({ userId: 'u1', isAdmin: false } as Principal, 'm1')
    expect(bare.prisma.memo.updateMany.mock.calls[0]![0]).toMatchObject({ data: { status: 'uploaded' } })
  })

  it('refuses a memo that is not failed, and queues nothing', async () => {
    const { memos, producer } = service({ ...base, status: 'done', transcript: null }, 0)
    await expect(memos.retry({ userId: 'u1', isAdmin: false } as Principal, 'm1')).rejects.toBeInstanceOf(ConflictException)
    expect(producer.enqueue).not.toHaveBeenCalled()
  })
})
