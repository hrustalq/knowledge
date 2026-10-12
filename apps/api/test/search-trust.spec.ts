import { describe, expect, it, vi } from 'vitest';
import { TRUST_WEIGHTS } from '@knowledge/contracts';
import { SearchService } from '../src/search/search.service.js';

/**
 * The trust re-rank (docs/features/39): archived pages drop, a page's state
 * multiplies its fused score, the cut to k happens after the re-sort, the
 * kill switch restores the old order and the old candidate count exactly, and
 * every hit says what it was ranked by.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const NOW = Date.now();
const day = 86_400_000;

type Row = {
  id: string;
  title: string;
  category: string;
  projectId: string;
  defaultBranch: string;
  verifiedAt: Date | null;
  verifiedRevisionId: string | null;
  verificationExpiresAt: Date | null;
  verificationFlag: string | null;
  ownerId: string | null;
  lastActivityAt: Date;
  archivedAt: Date | null;
  branches: { name: string; headRevisionId: string | null }[];
};

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    title: id,
    category: 'guide',
    projectId: 'p',
    defaultBranch: 'main',
    verifiedAt: null,
    verifiedRevisionId: null,
    verificationExpiresAt: null,
    verificationFlag: null,
    ownerId: null,
    lastActivityAt: new Date(NOW - day),
    archivedAt: null,
    branches: [{ name: 'main', headRevisionId: 'head' }],
    ...over,
  };
}

function hit(documentId: string, score: number) {
  return { documentId, revisionId: 'head', chunkId: `c-${documentId}`, text: `text of ${documentId}`, headingPath: [], score };
}

function build(docs: Row[], hits: ReturnType<typeof hit>[], trustRanking = true) {
  const prisma = {
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; archivedAt?: unknown } }) =>
        docs.filter((d) => where.id.in.includes(d.id) && (where.archivedAt === undefined || d.archivedAt)),
      ),
    },
  };
  const graph = {
    searchChunks: vi.fn(async (_ws: string, _e: number[], k: number) => hits.slice(0, k)),
    getDocumentIdsByTags: vi.fn(async () => new Set<string>()),
    getWorkspaceRelationGraph: vi.fn(async () => ({ edges: [], entities: {}, documents: {} })),
  };
  const embeddings = { embed: vi.fn(async () => [0.1, 0.2]) };
  const fulltext = { enabled: false, search: vi.fn(async () => []) };
  const provenance = { openIssueCounts: vi.fn(async () => new Map<string, number>()) };
  const policy = {
    effective: vi.fn(async () => ({ reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40, trustRanking })),
  };
  const svc = new SearchService(prisma as never, graph as never, embeddings as never, fulltext as never, provenance as never, policy as never);
  return { svc, graph, prisma };
}

const verified = row('verified', { verifiedAt: new Date(NOW - day), verifiedRevisionId: 'head', verificationExpiresAt: new Date(NOW + 30 * day) });
const plain = row('plain');
const expired = row('expired', { verifiedAt: new Date(NOW - 100 * day), verifiedRevisionId: 'head', verificationExpiresAt: new Date(NOW - day) });
const outdated = row('outdated', { verificationFlag: 'outdated' });
const archived = row('archived', { archivedAt: new Date() });
const inactive = row('inactive', { lastActivityAt: new Date(NOW - 400 * day) });

describe('SearchService trust re-rank', () => {
  it('ranks equally relevant pages verified > unverified > expired > outdated and attaches trust to every hit', async () => {
    const { svc } = build(
      [verified, plain, expired, outdated],
      [hit('outdated', 0.5), hit('expired', 0.5), hit('plain', 0.5), hit('verified', 0.5)],
    );
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' });
    expect(res.results.map((r) => r.documentId)).toEqual(['verified', 'plain', 'expired', 'outdated']);
    expect(res.results.map((r) => r.trust?.status)).toEqual(['verified', 'unverified', 'expired', 'outdated']);
    expect(res.results[0]!.score).toBeCloseTo(0.5 * TRUST_WEIGHTS.verified, 4);
    expect(res.results[3]!.score).toBeCloseTo(0.5 * TRUST_WEIGHTS.outdated, 4);
    expect(res.results[0]!.trust).toMatchObject({ verifiedAt: verified.verifiedAt!.toISOString(), inactive: false });
  });

  it('drops archived pages and marks inactivity, then cuts to k after the re-sort', async () => {
    const { svc, graph } = build(
      [verified, archived, inactive, outdated],
      [hit('archived', 0.9), hit('outdated', 0.8), hit('inactive', 0.7), hit('verified', 0.5)],
    );
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 2 });
    // At least 2k candidates were asked for so the demoted hits could be displaced:
    // the archived top hit drops, the outdated one sinks under the verified one.
    expect(graph.searchChunks).toHaveBeenCalledWith(WS, expect.any(Array), 4);
    expect(res.results.map((r) => r.documentId)).toEqual(['inactive', 'verified']);
    expect(res.results[0]!.trust).toMatchObject({ status: 'unverified', inactive: true });
    expect(res.results[0]!.score).toBeCloseTo(0.7 * TRUST_WEIGHTS.inactive, 4);
  });

  it('includeArchived keeps archived pages and verificationStates narrows the hit set', async () => {
    const { svc } = build([verified, plain, archived], [hit('archived', 0.9), hit('plain', 0.6), hit('verified', 0.5)]);
    const withArchived = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', filters: { includeArchived: true } });
    expect(withArchived.results.map((r) => r.documentId)).toContain('archived');

    const onlyVerified = await svc.search({
      workspaceId: WS,
      query: 'q',
      mode: 'semantic',
      filters: { verificationStates: ['verified'] },
    });
    expect(onlyVerified.results.map((r) => r.documentId)).toEqual(['verified']);
  });

  it('with the switch off, the order and the candidate count are exactly the pre-#66 ones', async () => {
    const { svc, graph } = build(
      [verified, plain, expired, outdated],
      [hit('outdated', 0.8), hit('expired', 0.7), hit('plain', 0.6), hit('verified', 0.5)],
      false,
    );
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic', limit: 3 });
    expect(graph.searchChunks).toHaveBeenCalledWith(WS, expect.any(Array), 3);
    expect(res.results.map((r) => r.documentId)).toEqual(['outdated', 'expired', 'plain']);
    expect(res.results.map((r) => r.score)).toEqual([0.8, 0.7, 0.6]);
    // The status still travels with the hit; only the weight is off.
    expect(res.results[0]!.trust?.status).toBe('outdated');
  });

  it('still drops archived pages with the switch off: archive is not a demotion', async () => {
    const { svc } = build([plain, archived], [hit('archived', 0.9), hit('plain', 0.6)], false);
    const res = await svc.search({ workspaceId: WS, query: 'q', mode: 'semantic' });
    expect(res.results.map((r) => r.documentId)).toEqual(['plain']);
  });
});
