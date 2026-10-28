import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException, PayloadTooLargeException, ServiceUnavailableException } from '@nestjs/common';
import { memoExtensionFor } from '@knowledge/contracts';
import { MemosService, transcriptionState } from '../src/memos/memos.service.js';
import type { Principal } from '../src/auth/principal.js';
import { stitchTranscript } from '../src/memos/transcript.js';
import { fixedCuts, parsePauses, pauseCuts } from '../src/memos/audio.js';
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
    expect(transcriptionState('none', 'http://x', 'k')).toEqual({ enabled: false, missing: 'TRANSCRIPTION_PROVIDER' });
    expect(transcriptionState('openai-compatible', ' ', 'k')).toEqual({ enabled: false, missing: 'TRANSCRIPTION_BASE_URL' });
    expect(transcriptionState('openai-compatible', 'http://x', '')).toEqual({ enabled: true, missing: null });
  });

  it('asks gen-api for its key only (#584)', () => {
    expect(transcriptionState('gen-api', '', ' ')).toEqual({ enabled: false, missing: 'TRANSCRIPTION_API_KEY' });
    expect(transcriptionState('gen-api', '', 'k')).toEqual({ enabled: true, missing: null });
  });
});

describe('memo chunk cuts (#584)', () => {
  it('reads the middle of each pause from silencedetect', () => {
    const log = [
      '[silencedetect @ 0x1] silence_start: -0.01',
      '[silencedetect @ 0x1] silence_end: 0.5 | silence_duration: 0.51',
      '[silencedetect @ 0x1] silence_start: 41',
      '[silencedetect @ 0x1] silence_end: 42 | silence_duration: 1',
      '[silencedetect @ 0x1] silence_start: 99.5',
    ].join('\n');
    expect(parsePauses(log)).toEqual([0.25, 41.5]);
  });

  it('cuts at the latest pause in the second half of each minute, hard where there is none', () => {
    // 10 and 70 sit in a first half; 45 and 55 share a window (55 wins); 170–200 has no pause.
    expect(pauseCuts([10, 45, 55, 70, 100, 140], 250)).toEqual([55, 100, 140, 200]);
    expect(pauseCuts([30], 60)).toEqual([]);
  });

  it('keeps ten-minute pieces for a server that times its own segments', () => {
    expect(fixedCuts(599)).toEqual([]);
    expect(fixedCuts(1300)).toEqual([600, 1200]);
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
