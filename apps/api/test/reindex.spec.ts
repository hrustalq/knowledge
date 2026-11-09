import { describe, expect, it, vi } from 'vitest';
import { queueReindex } from '../src/ingestion/reindex.js';

const target = { workspaceId: 'ws', documentId: 'd1', revisionId: 'r1', s3Key: 'k', title: 'T', reason: 'test' };

function fakes(pending: boolean, enqueue = vi.fn(async () => undefined)) {
  const prisma = {
    ingestionJob: {
      findFirst: vi.fn(async () => (pending ? { id: 'busy' } : null)),
      create: vi.fn(async () => ({ id: 'job-1' })),
    },
  };
  return { prisma, producer: { enqueue } };
}

describe('queueReindex', () => {
  it('writes the outbox row, then enqueues it', async () => {
    const { prisma, producer } = fakes(false);
    expect(await queueReindex(prisma as never, producer, target, { skipPending: true })).toBe('job-1');
    expect(prisma.ingestionJob.create).toHaveBeenCalledWith({
      data: { workspaceId: 'ws', revisionId: 'r1', type: 'reindex', status: 'queued', payload: { documentId: 'd1', revisionId: 'r1', s3Key: 'k', title: 'T', reason: 'test' } },
    });
    expect(producer.enqueue).toHaveBeenCalledWith('job-1');
  });

  it('leaves a revision with a queued or running job to it, unless forced', async () => {
    const skipped = fakes(true);
    expect(await queueReindex(skipped.prisma as never, skipped.producer, target, { skipPending: true })).toBeNull();
    expect(skipped.prisma.ingestionJob.create).not.toHaveBeenCalled();
    const forced = fakes(true);
    expect(await queueReindex(forced.prisma as never, forced.producer, target, { skipPending: false })).toBe('job-1');
    expect(forced.prisma.ingestionJob.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the row when the enqueue fails: the outbox sweeper retries it', async () => {
    const { prisma, producer } = fakes(false, vi.fn(async () => Promise.reject(new Error('redis down'))));
    expect(await queueReindex(prisma as never, producer, target, { skipPending: true })).toBe('job-1');
  });
});
