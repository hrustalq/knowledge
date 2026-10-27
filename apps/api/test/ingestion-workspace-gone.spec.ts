import { describe, expect, it, vi } from 'vitest';
import { IngestionProcessor } from '../src/ingestion/ingestion.processor.js';

/**
 * #544 — the worker reads "this workspace is gone" off the tombstone (#479),
 * the same as the API. A workspace with no row is the dev principal's default
 * workspace, not a deleted one, and its pages must index.
 */

const MAX_ATTEMPTS = 5;

function processorWith(workspace: { deletedAt: Date | null } | null) {
  const prisma = {
    workspace: { findUnique: vi.fn(async () => workspace) },
    ingestionJob: {
      findUnique: vi.fn(async () => ({ id: 'job', status: 'queued', attempts: 0, workspaceId: 'ws', revisionId: 'rev', payload: {} })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    // Null stops the pipeline right after the workspace gate, which is all these cases need.
    documentRevision: { findUnique: vi.fn(async () => null) },
  };
  const config = { get: vi.fn((key: string) => (key === 'STALE_MAX_ATTEMPTS' ? MAX_ATTEMPTS : 0)) };
  const none = undefined as never;
  const processor = new IngestionProcessor(
    prisma as never, none, none, none, none, none, config as never, none, none, none, none, none, none, none,
  );
  return { processor, prisma, run: () => processor.process({ data: { ingestionJobId: 'job' } } as never) };
}

describe('IngestionProcessor workspace gate (#544)', () => {
  it('processes a job in a workspace that has no row', async () => {
    const { prisma, run } = processorWith(null);
    await expect(run()).rejects.toThrow('Revision rev not found');
    expect(prisma.ingestionJob.updateMany).not.toHaveBeenCalled();
  });

  it('fails a tombstoned workspace job once, with attempts at the sweeper ceiling', async () => {
    const { prisma, run } = processorWith({ deletedAt: new Date() });
    await run();
    expect(prisma.documentRevision.findUnique).not.toHaveBeenCalled();
    expect(prisma.ingestionJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job' },
      data: { status: 'failed', attempts: MAX_ATTEMPTS, error: { message: 'workspace deleted' } },
    });
  });
});
