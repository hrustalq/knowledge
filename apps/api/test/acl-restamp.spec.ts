import { describe, expect, it, vi } from 'vitest';
import { AclRestampSweeper } from '../src/permissions/acl-restamp.sweeper.js';

/**
 * The re-stamp sweeper, #76 phase 3: a page whose `restricted_by` changed
 * (acl_version ahead of acl_stamped_version) gets its stamps rewritten in both
 * stores and is marked done — guarded on the version it stamped, so a change
 * that lands meanwhile is stamped on the next tick. Nothing is re-embedded.
 */

const due = [
  { id: 'doc-1', workspace_id: 'ws', restricted_by: ['node-a'], acl_version: 3 },
  { id: 'doc-2', workspace_id: 'ws', restricted_by: [], acl_version: 1 },
];

function build(opts: { fulltextFails?: string; versionMoved?: string } = {}) {
  const prisma = {
    $queryRaw: vi.fn(async () => due),
    document: {
      updateMany: vi.fn(async ({ where }: { where: { id: string } }) => ({ count: where.id === opts.versionMoved ? 0 : 1 })),
    },
  };
  const graph = { restampDocument: vi.fn(async () => undefined) };
  const fulltext = {
    enabled: true,
    restamp: vi.fn(async (_ws: string, id: string) => {
      if (id === opts.fulltextFails) throw new Error('opensearch down');
    }),
  };
  const config = { get: vi.fn((key: string) => ({ ACL_RESTAMP_BATCH: 200, ACL_RESTAMP_TICK_MS: 30_000 })[key]) };
  const sweeper = new AclRestampSweeper(prisma as never, graph as never, fulltext as never, config as never);
  return { sweeper, prisma, graph, fulltext };
}

describe('AclRestampSweeper', () => {
  it('rewrites both stores and records the stamped version, guarded on it', async () => {
    // No embedding provider is even injected: a restamp cannot re-embed.
    const { sweeper, prisma, graph, fulltext } = build();
    expect(await sweeper.sweep()).toBe(2);
    expect(graph.restampDocument).toHaveBeenCalledWith('ws', 'doc-1', ['node-a']);
    expect(fulltext.restamp).toHaveBeenCalledWith('ws', 'doc-2', []);
    expect(prisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', aclVersion: 3 },
      data: { aclStampedVersion: 3 },
    });
  });

  it('leaves a page due when a store failed or its version moved meanwhile', async () => {
    const { sweeper, prisma } = build({ fulltextFails: 'doc-1', versionMoved: 'doc-2' });
    expect(await sweeper.sweep()).toBe(0);
    // doc-1 never reached the version write; doc-2's guarded write matched nothing.
    expect(prisma.document.updateMany).toHaveBeenCalledTimes(1);
  });

  it('never runs two ticks at once', async () => {
    const { sweeper, prisma } = build();
    let release!: () => void;
    prisma.$queryRaw.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(due))));
    const first = sweeper.sweep();
    expect(await sweeper.sweep()).toBe(0);
    release();
    expect(await first).toBe(2);
  });
});
