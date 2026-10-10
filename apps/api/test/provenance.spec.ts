import { describe, expect, it, vi } from 'vitest';
import type { AssistantSource } from '@knowledge/contracts';
import { ProvenanceService } from '../src/feedback/provenance.service.js';

/**
 * Provenance resolution (docs/features/38): one batched read per answer, the
 * pinned workspace as the boundary, and the verification state derived from the
 * stamp against the head rather than read from a column.
 */

const WS = '11111111-1111-4111-8111-111111111111';

function prismaWith(docs: unknown[], revisions: unknown[], users: unknown[]) {
  return {
    document: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) =>
      (docs as Array<{ id: string; workspaceId: string }>).filter((d) => where.id.in.includes(d.id) && d.workspaceId === where.workspaceId)) },
    documentRevision: { findMany: vi.fn(async () => revisions) },
    user: { findMany: vi.fn(async () => users) },
    // No open reports: nothing is flagged (phase 3 counts them here).
    knowledgeIssue: { groupBy: vi.fn(async () => []) },
  };
}

const docs = [
  {
    id: 'doc-a', workspaceId: WS, defaultBranch: 'main',
    verifiedAt: new Date('2026-10-01T00:00:00Z'), verifiedBy: 'u-2', verifiedRevisionId: 'rev-a2',
    branches: [{ name: 'main', headRevisionId: 'rev-a2' }, { name: 'draft', headRevisionId: 'rev-a3' }],
  },
  {
    id: 'doc-b', workspaceId: WS, defaultBranch: 'main',
    verifiedAt: new Date('2026-01-01T00:00:00Z'), verifiedBy: 'u-2', verifiedRevisionId: 'rev-b1',
    branches: [{ name: 'main', headRevisionId: 'rev-b2' }],
  },
  { id: 'doc-c', workspaceId: WS, defaultBranch: 'main', verifiedAt: null, verifiedBy: null, verifiedRevisionId: null, branches: [{ name: 'main', headRevisionId: null }] },
  { id: 'doc-x', workspaceId: '22222222-2222-4222-8222-222222222222', defaultBranch: 'main', verifiedAt: null, verifiedBy: null, verifiedRevisionId: null, branches: [] },
];
const revisions = [
  { id: 'rev-a2', revisionNumber: 2, authorId: 'u-1', finalizedAt: new Date('2026-09-30T12:00:00Z'), createdAt: new Date('2026-09-30T11:00:00Z') },
  { id: 'rev-b2', revisionNumber: 2, authorId: 'u-3', finalizedAt: null, createdAt: new Date('2026-05-01T00:00:00Z') },
];
const users = [{ id: 'u-1', displayName: 'Ada' }, { id: 'u-2', displayName: 'Grace' }];

describe('ProvenanceService', () => {
  it('resolves head, author, freshness and the derived verification state in one batch', async () => {
    const prisma = prismaWith(docs, revisions, users);
    const svc = new ProvenanceService(prisma as never);
    const map = await svc.forDocuments(WS, ['doc-a', 'doc-b', 'doc-c', 'doc-a']);

    expect(prisma.document.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.documentRevision.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);

    expect(map.get('doc-a')).toMatchObject({
      headRevisionId: 'rev-a2',
      revisionNumber: 2,
      authorId: 'u-1',
      authorName: 'Ada',
      changedAt: '2026-09-30T12:00:00.000Z',
      verification: 'verified',
      verifiedByName: 'Grace',
    });
    // The head moved since the stamp: outdated, with nothing written anywhere.
    expect(map.get('doc-b')).toMatchObject({ verification: 'outdated', authorName: null, changedAt: '2026-05-01T00:00:00.000Z' });
    // No head at all: unverified, and no revision facts to report.
    expect(map.get('doc-c')).toMatchObject({ verification: 'unverified', revisionNumber: null, changedAt: null });
  });

  it('drops a page from another workspace rather than describing it', async () => {
    const svc = new ProvenanceService(prismaWith(docs, revisions, users) as never);
    const sources: AssistantSource[] = [
      { documentId: 'doc-a', title: 'A', cite: 'S1', snippet: 'x' },
      { documentId: 'doc-x', title: 'Foreign', cite: 'S2' },
      { kind: 'web', url: 'https://x.test/', site: 'x.test', title: 'Web', cite: 'S3' },
    ];
    const out = await svc.decorateSources(WS, sources);
    expect(out.map((s) => s.cite)).toEqual(['S1', 'S3']);
    expect(out[0]).toMatchObject({ cite: 'S1', snippet: 'x', revisionNumber: 2, verification: 'verified', factClass: 'explicit' });
    expect(out[1]).toEqual(sources[2]);
  });

  it('keeps a graph-reached fact class and decorates search hits the same way', async () => {
    const svc = new ProvenanceService(prismaWith(docs, revisions, users) as never);
    const [inferred] = await svc.decorateSources(WS, [{ documentId: 'doc-a', title: 'A', factClass: 'inferred' }]);
    expect(inferred).toMatchObject({ factClass: 'inferred' });

    const hits = await svc.decorateResults(WS, [
      { documentId: 'doc-b', revisionId: 'rev-b2', chunkId: 'c', title: 'B', snippet: '', score: 0.5 },
    ]);
    expect(hits[0]).toMatchObject({ revisionId: 'rev-b2', revisionNumber: 2, verification: 'outdated', factClass: 'explicit' });
  });

  it('asks nothing when there is nothing to resolve', async () => {
    const prisma = prismaWith(docs, revisions, users);
    const svc = new ProvenanceService(prisma as never);
    expect(await svc.forDocuments(WS, [])).toEqual(new Map());
    expect(prisma.document.findMany).not.toHaveBeenCalled();
  });
});
