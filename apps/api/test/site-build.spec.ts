import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { planSiteBuild, resolveRevision, type PlanDocument, type ResolvedRevision } from '../src/publishing/site-build.plan.js';
import { SiteBuildService } from '../src/publishing/site-build.service.js';
import { SiteRebuildTrigger } from '../src/publishing/site-rebuild.trigger.js';

/**
 * Site builds (docs/features/44, issue #77 phase 2a). What is pinned:
 * - only an indexed revision is ever published; a head that is not indexed
 *   publishes the newest indexed one before it, with a warning, and a page
 *   with none is left out without hiding its subpages;
 * - the branch rule: the version's branch where a page has it, its default
 *   branch where it does not;
 * - slugs: per-level from titles, deduplicated among siblings, stepping
 *   around version slugs at the top, Unicode kept, hyphen runs tidied;
 * - the swap: one transaction replaces the snapshot, and a failed build
 *   leaves the old one in place;
 * - the trigger rebuilds live versions only, for the page's site and for any
 *   site that already publishes it.
 */

const doc = (id: string, title: string, parentId: string | null = null, position = 0): PlanDocument => ({
  id,
  title,
  parentId,
  position,
});
const indexed = (id: string): ResolvedRevision => ({ revisionId: `rev-${id}`, headIndexed: true });

function plan(documents: PlanDocument[], revisions?: Map<string, ResolvedRevision>, extra: Partial<Parameters<typeof planSiteBuild>[0]> = {}) {
  return planSiteBuild({
    documents,
    revisions: revisions ?? new Map(documents.map((d) => [d.id, indexed(d.id)])),
    rootDocumentId: null,
    reservedTopSegments: new Set(),
    maxPages: 1000,
    ...extra,
  });
}

describe('resolveRevision', () => {
  it('publishes an indexed head as it is', () => {
    expect(resolveRevision({ id: 'h', status: 'indexed' }, { id: 'old' })).toEqual({ revisionId: 'h', headIndexed: true });
  });

  it('falls back to the newest indexed revision when the head is still indexing or failed', () => {
    expect(resolveRevision({ id: 'h', status: 'failed' }, { id: 'old' })).toEqual({ revisionId: 'old', headIndexed: false });
    expect(resolveRevision({ id: 'h', status: 'indexing' }, { id: 'old' })).toEqual({ revisionId: 'old', headIndexed: false });
  });

  it('publishes nothing when the branch has never indexed (a draft is never published)', () => {
    expect(resolveRevision({ id: 'h', status: 'draft' }, null)).toEqual({ revisionId: null });
    expect(resolveRevision(null, null)).toEqual({ revisionId: null });
  });
});

describe('planSiteBuild', () => {
  it('walks the tree in reading order, with depth, position and nested slug paths', () => {
    const { pages, warnings } = plan([
      doc('b', 'Reference', null, 1),
      doc('a', 'Guide', null, 0),
      doc('a2', 'Install', 'a', 1),
      doc('a1', 'Overview', 'a', 0),
    ]);
    expect(warnings).toEqual([]);
    expect(pages.map((p) => [p.documentId, p.slugPath, p.depth, p.position, p.parentId])).toEqual([
      ['a', 'guide', 0, 0, null],
      ['a1', 'guide/overview', 1, 0, 'a'],
      ['a2', 'guide/install', 1, 1, 'a'],
      ['b', 'reference', 0, 1, null],
    ]);
  });

  it('deduplicates sibling slugs, keeps Unicode, tidies hyphen runs and never yields an empty segment', () => {
    const { pages } = plan([
      doc('1', 'Setup', null, 0),
      doc('2', 'setup', null, 1),
      doc('3', 'Установка — OMS', null, 2),
      doc('4', '???', null, 3),
      doc('5', 'API - Overview', null, 4),
    ]);
    expect(pages.map((p) => p.slugPath)).toEqual(['setup', 'setup-2', 'установка-oms', 'page', 'api-overview']);
  });

  it('steps a top-level slug around the version slugs, which own the first URL segment', () => {
    const { pages } = plan([doc('1', 'Next'), doc('2', 'Child', '1')], undefined, { reservedTopSegments: new Set(['next', 'latest']) });
    expect(pages.map((p) => p.slugPath)).toEqual(['next-2', 'next-2/child']);
  });

  it('leaves out a page with nothing indexed, hangs its subpages from the nearest published ancestor, and warns', () => {
    const revisions = new Map<string, ResolvedRevision>([
      ['a', indexed('a')],
      ['b', { revisionId: null }],
      ['c', indexed('c')],
      ['d', { revisionId: 'rev-d-old', headIndexed: false }],
    ]);
    const { pages, warnings } = plan([doc('a', 'A'), doc('b', 'B', 'a'), doc('c', 'C', 'b'), doc('d', 'D', 'a', 1)], revisions);
    expect(pages.map((p) => [p.documentId, p.parentId, p.depth, p.slugPath, p.revisionId])).toEqual([
      ['a', null, 0, 'a', 'rev-a'],
      ['c', 'a', 1, 'a/c', 'rev-c'],
      ['d', 'a', 1, 'a/d', 'rev-d-old'],
    ]);
    expect(warnings).toEqual([
      { code: 'noIndexedRevision', documentId: 'b', title: 'B' },
      { code: 'headNotIndexed', documentId: 'd', title: 'D' },
    ]);
  });

  it('surfaces a page whose parent is out of scope as top level (the getTree orphan rule)', () => {
    const { pages } = plan([doc('x', 'Orphan', 'gone')]);
    expect(pages[0]).toMatchObject({ parentId: null, depth: 0, slugPath: 'orphan' });
  });

  it('with a root page: the root is home at "" and its subpages are at the top of the URL space', () => {
    const { pages } = plan([doc('r', 'Handbook', 'outside'), doc('k', 'Install', 'r')], undefined, {
      rootDocumentId: 'r',
      reservedTopSegments: new Set(['install']),
    });
    expect(pages.map((p) => [p.documentId, p.slugPath, p.depth, p.parentId])).toEqual([
      ['r', '', 0, null],
      ['k', 'install-2', 1, 'r'],
    ]);
  });

  it('cuts at maxPages in reading order with one warning', () => {
    const { pages, warnings } = plan([doc('1', 'One', null, 0), doc('2', 'Two', null, 1), doc('3', 'Three', null, 2)], undefined, { maxPages: 2 });
    expect(pages.map((p) => p.documentId)).toEqual(['1', '2']);
    expect(warnings).toEqual([{ code: 'pageLimit', documentId: null, title: null }]);
  });
});

/** Just enough Prisma for SiteBuildService. */
function buildPrisma() {
  const version = {
    id: 'v1',
    sourceBranch: 'next' as string | null,
    site: { workspaceId: 'ws', projectId: 'p', rootDocumentId: null as string | null, versions: [{ id: 'v1', slug: 'latest' }] },
  };
  const documents = [
    { id: 'a', parentId: null, title: 'Alpha', position: 0, defaultBranch: 'main', branches: [
      { id: 'a-main', name: 'main', headRevisionId: 'a-r1' },
      { id: 'a-next', name: 'next', headRevisionId: 'a-r2' },
    ] },
    { id: 'b', parentId: null, title: 'Beta', position: 1, defaultBranch: 'main', branches: [{ id: 'b-main', name: 'main', headRevisionId: 'b-r2' }] },
  ];
  const revisions = [
    { id: 'a-r1', status: 'indexed', branchId: 'a-main', revisionNumber: 1 },
    { id: 'a-r2', status: 'indexed', branchId: 'a-next', revisionNumber: 2 },
    { id: 'b-r1', status: 'indexed', branchId: 'b-main', revisionNumber: 1 },
    { id: 'b-r2', status: 'failed', branchId: 'b-main', revisionNumber: 2 },
  ];
  let pages: Array<Record<string, unknown>> = [{ versionId: 'v1', documentId: 'stale', slugPath: 'stale' }];
  const versionRow: Record<string, unknown> = { id: 'v1', status: 'ready' };
  const prisma = {
    get pages() {
      return pages;
    },
    versionRow,
    siteVersion: {
      findUnique: vi.fn(async () => version),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(versionRow, data)),
    },
    document: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        where.id ? documents.filter((d) => where.id!.in.includes(d.id)) : documents.map(({ branches: _b, defaultBranch: _d, ...rest }) => rest),
      ),
    },
    documentRevision: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; branchId?: { in: string[] }; status?: string } }) => {
        if (where.id) return revisions.filter((r) => where.id!.in.includes(r.id));
        return revisions
          .filter((r) => where.branchId!.in.includes(r.branchId) && r.status === where.status)
          .sort((x, y) => y.revisionNumber - x.revisionNumber)
          .filter((r, i, all) => all.findIndex((o) => o.branchId === r.branchId) === i);
      }),
    },
    siteVersionPage: {
      deleteMany: vi.fn(() => ({ op: 'delete' })),
      createMany: vi.fn((args: { data: Array<Record<string, unknown>> }) => ({ op: 'create', args })),
    },
    failSwap: false,
    $transaction: vi.fn(async (ops: Array<{ op?: string; args?: { data: Array<Record<string, unknown>> } }>) => {
      if (prisma.failSwap) throw new Error('deadlock');
      for (const op of ops) {
        if (op.op === 'delete') pages = [];
        if (op.op === 'create') pages = [...op.args!.data];
      }
    }),
  };
  return prisma;
}

const config = { get: (k: string) => ({ SITE_MAX_PAGES: 2000 })[k as 'SITE_MAX_PAGES'] };

/** Text per revision, and the vector statement as a marker the fake transaction can see. */
function searchText() {
  return {
    texts: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { headings: `h ${id}`, body: `body ${id}` }]))),
    indexVersion: vi.fn((versionId: string) => ({ op: 'index', versionId })),
  };
}

/** The audience stamper with no rules: every row public, which is what every pre-phase-3 build wrote. */
function stamper() {
  return {
    rules: vi.fn(async () => new Map()),
    stampFor: vi.fn(() => ({ audience: 'public', claims: null })),
    restamp: vi.fn(async () => undefined),
  };
}

describe('SiteBuildService', () => {
  it('reads the named branch where a page has it and its default branch where it does not', async () => {
    const prisma = buildPrisma();
    await new SiteBuildService(prisma as never, config as never, searchText() as never, stamper() as never).build('v1');
    const byDoc = Object.fromEntries(prisma.pages.map((p) => [p.documentId, p.revisionId]));
    // a has `next`; b does not, so b falls back to `main`, whose failed head
    // gives way to the newest indexed revision.
    expect(byDoc).toEqual({ a: 'a-r2', b: 'b-r1' });
    expect(prisma.versionRow).toMatchObject({ status: 'ready', pageCount: 2, error: null });
    expect(prisma.versionRow.warnings).toEqual([{ code: 'headNotIndexed', documentId: 'b', title: 'Beta' }]);
  });

  it('replaces the snapshot in one transaction: delete, insert, search vectors and the ready stamp together', async () => {
    const prisma = buildPrisma();
    await new SiteBuildService(prisma as never, config as never, searchText() as never, stamper() as never).build('v1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = prisma.$transaction.mock.calls[0][0] as Array<{ op?: string; versionId?: string }>;
    expect(ops).toHaveLength(4);
    // The vectors are computed after the insert and before the stamp, so a
    // snapshot is never served without its search index.
    expect(ops[2]).toEqual({ op: 'index', versionId: 'v1' });
    expect(prisma.pages.some((p) => p.documentId === 'stale')).toBe(false);
  });

  it('stores each page’s search text from the revision it publishes', async () => {
    const prisma = buildPrisma();
    const text = searchText();
    await new SiteBuildService(prisma as never, config as never, text as never, stamper() as never).build('v1');
    expect(text.texts).toHaveBeenCalledWith(['a-r2', 'b-r1']);
    expect(prisma.pages.map((p) => [p.documentId, p.searchHeadings, p.searchBody])).toEqual([
      ['a', 'h a-r2', 'body a-r2'],
      ['b', 'h b-r1', 'body b-r1'],
    ]);
  });

  it('a failed swap leaves the old snapshot served and marks the version failed', async () => {
    const prisma = buildPrisma();
    prisma.failSwap = true;
    await expect(new SiteBuildService(prisma as never, config as never, searchText() as never, stamper() as never).build('v1')).rejects.toThrow('deadlock');
    expect(prisma.pages).toEqual([{ versionId: 'v1', documentId: 'stale', slugPath: 'stale' }]);
    expect(prisma.versionRow).toMatchObject({ status: 'failed', error: 'deadlock' });
  });

  it('publishes nothing from a root page that is gone, rather than the whole project', async () => {
    const prisma = buildPrisma();
    (await prisma.siteVersion.findUnique()).site.rootDocumentId = 'deleted-root';
    await new SiteBuildService(prisma as never, config as never, searchText() as never, stamper() as never).build('v1');
    expect(prisma.pages).toEqual([]);
    expect(prisma.versionRow).toMatchObject({ status: 'ready', pageCount: 0 });
  });
});

describe('SiteRebuildTrigger', () => {
  function trigger() {
    const prisma = {
      document: { findUnique: vi.fn(async () => ({ workspaceId: 'ws', projectId: 'p' })) },
      siteVersion: {
        findMany: vi.fn(async ({ where }: { where: { kind: string; site?: unknown; pages?: unknown } }) => {
          expect(where.kind).toBe('live'); // frozen versions are never touched
          return where.site ? [{ id: 'live-1' }] : [{ id: 'live-1' }, { id: 'live-other-site' }];
        }),
      },
    };
    const producer = { enqueue: vi.fn(async () => undefined) };
    return { prisma, producer, t: new SiteRebuildTrigger(prisma as never, { all: () => ({ subscribe: () => undefined }) } as never, producer as never) };
  }

  it('debounces a rebuild of every live version the page belongs to, once each', async () => {
    const { t, producer } = trigger();
    await t.handle({ type: 'revision.indexed', workspaceId: 'ws', documentId: 'doc', at: '' } as never);
    expect(producer.enqueue.mock.calls).toEqual([['live-1'], ['live-other-site']]);
  });

  it('ignores events that cannot change a site (comments, verification, events without a page)', async () => {
    const { t, producer } = trigger();
    await t.handle({ type: 'document.comment.created', workspaceId: 'ws', documentId: 'doc', at: '' } as never);
    await t.handle({ type: 'revision.indexed', workspaceId: 'ws', at: '' } as never);
    expect(producer.enqueue).not.toHaveBeenCalled();
  });
});
