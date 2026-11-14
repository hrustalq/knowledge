import { describe, expect, it, vi } from 'vitest';
import { ImportProcessor } from '../src/import/import.processor.js';

/**
 * #1086: an import's frames name the staged file and carry its id, which every
 * import route answers for. They are the uploader's, addressed the way
 * `export.*` and `memo.*` are, never a workspace broadcast.
 */
const ROW = {
  id: 'imp-1',
  workspaceId: 'ws-1',
  createdBy: 'uploader-1',
  sourceFilename: 'secret plan.md',
  contentType: 'text/markdown',
  s3Key: 'k',
  locale: 'en',
};

function processor(parse: () => Promise<unknown>) {
  const publish = vi.fn(async () => undefined);
  const prisma = {
    importJob: {
      findUnique: async () => ROW,
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
  };
  const storage = {
    getObjectBytes: async () => Buffer.from('x'),
    putObjectText: async () => undefined,
    putObjectBytes: async () => undefined,
    importObjectKey: (_ws: string, _id: string, name: string) => name,
  };
  const parsers = { resolve: () => ({ id: 'markdown', parse }) };
  const config = { get: () => 60_000 };
  const p = new ImportProcessor(prisma as never, storage as never, parsers as never, { publish } as never, config as never);
  return { p, publish };
}

describe('import frames (#1086)', () => {
  it('addresses import.parsed to the uploader', async () => {
    const { p, publish } = processor(async () => ({ markdown: '# T\n\nbody', title: 'T', warnings: [], meta: {} }));
    await p.process({ data: { importJobId: ROW.id } } as never);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'import.parsed', userId: ROW.createdBy }));
  });

  it('addresses import.failed to the uploader', async () => {
    const { p, publish } = processor(async () => {
      throw new Error('unreadable');
    });
    await p.process({ data: { importJobId: ROW.id } } as never);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'import.failed', userId: ROW.createdBy }));
  });
});
