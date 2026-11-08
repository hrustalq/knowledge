import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service.js';

/**
 * #807: every tree write takes the project's commit lock first, then reads the
 * tree under it. The fake keeps one in-memory documents table, yields on every
 * query so concurrent calls interleave, and models `commits.lock` as
 * `pg_advisory_xact_lock`: a mutex held until the transaction that took it
 * ends, re-entrant within it. The `$executeRaw` handler does what the
 * repath/renumber SQL does. It does not roll back writes, so cases assert only
 * on what the refused call never reaches.
 */
type Doc = {
  id: string;
  workspaceId: string;
  projectId: string;
  parentId: string | null;
  path: string;
  depth: number;
  position: number;
  title: string;
  slug: string | null;
  restricted: boolean;
  restrictedBy: string[];
  archivedAt: null;
};

const WS = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise((r) => setImmediate(r));

function rig(seed: Array<Partial<Doc> & { id: string }>) {
  const blank = (id: string): Doc => ({
    id,
    workspaceId: WS,
    projectId: 'p1',
    parentId: null,
    path: `/${id}/`,
    depth: 0,
    position: 0,
    title: id,
    slug: id,
    restricted: false,
    restrictedBy: [],
    archivedAt: null,
  });
  const docs = new Map<string, Doc>(seed.map((d) => [d.id, { ...blank(d.id), ...d }]));
  const revisions: number[] = [];

  const tx = new AsyncLocalStorage<{ release?: () => void }>();
  let held: Promise<void> = Promise.resolve();
  const lock = async () => {
    const t = tx.getStore();
    if (!t) throw new Error('lock outside a transaction');
    if (t.release) return;
    const prev = held;
    held = new Promise((r) => (t.release = r));
    await prev;
  };

  const match = (d: Doc, w: any) =>
    (w.projectId === undefined || d.projectId === w.projectId) &&
    (w.parentId === undefined || d.parentId === w.parentId) &&
    (!w.id?.not || d.id !== w.id.not);
  const prisma = {
    withTransaction: (fn: () => Promise<unknown>) =>
      tx.getStore()
        ? fn()
        : tx.run({}, async () => {
            try {
              return await fn();
            } finally {
              tx.getStore()?.release?.();
            }
          }),
    onCommit: (fn: () => unknown) => void fn(),
    document: {
      findUnique: async ({ where }: any) => (await tick(), docs.has(where.id) ? { ...docs.get(where.id)! } : null),
      findMany: async ({ where }: any) =>
        (await tick(), [...docs.values()].filter((d) => match(d, where)).sort((a, b) => a.position - b.position).map((d) => ({ ...d }))),
      count: async ({ where }: any) => (await tick(), [...docs.values()].filter((d) => match(d, where)).length),
      update: async ({ where, data }: any) => (await tick(), { ...Object.assign(docs.get(where.id)!, data) }),
      create: async ({ data }: any) => (await tick(), docs.set(data.id, { ...blank(data.id), ...data }), { ...docs.get(data.id)! }),
    },
    documentBranch: {
      create: async () => ({ id: 'b-new' }),
      findUnique: async () => ({ id: 'b1', headRevisionId: null }),
    },
    connectorLink: { findFirst: async () => null },
    documentRevision: {
      aggregate: async () => (await tick(), { _max: { revisionNumber: revisions.length ? Math.max(...revisions) : null } }),
      create: async ({ data }: any) => {
        await tick();
        // The (documentId, revisionNumber) unique index.
        if (revisions.includes(data.revisionNumber)) throw new Error('P2002 unique revisionNumber');
        revisions.push(data.revisionNumber);
        return { id: `r${data.revisionNumber}`, ...data };
      },
      update: async ({ where, data }: any) => ({ id: where.id, ...data }),
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      await tick();
      const sql = strings.join('?');
      if (sql.includes('substring')) {
        const [newPath, from, delta, , like, self] = values;
        const prefix = like.slice(0, -1);
        for (const d of docs.values()) {
          if (d.id !== self && d.path.startsWith(prefix)) {
            d.path = newPath + d.path.slice(from - 1);
            d.depth += delta;
          }
        }
      } else if (sql.includes('unnest')) {
        const [ids, positions] = values as [string[], number[]];
        ids.forEach((id, i) => docs.has(id) && (docs.get(id)!.position = positions[i]));
      }
      return 1;
    },
  };

  // Restrictions follow the path, as `restricted_by` does.
  const permissions = {
    recomputeRestrictedBy: async () => {
      for (const d of docs.values()) d.restrictedBy = d.path.split('/').filter((id) => id && id !== d.id && docs.get(id)?.restricted);
    },
  };
  const commits = {
    lock,
    uniqueSlug: async (_p: string, _parent: string | null, id: string) => id,
    projectBranch: async () => 'pb1',
    recordState: async () => undefined,
    rehomeBranches: async () => undefined,
  };
  const ok = { record: async () => undefined, ensureSubscription: async () => undefined, requireProjectInWorkspace: async () => undefined };
  const storage = { revisionObjectKey: () => 'k', sourceObjectName: () => 'source.md' };
  const _ = {} as never;
  const svc = new DocumentsService(
    prisma as never,
    storage as never,
    _,
    _,
    ok as never,
    ok as never,
    ok as never,
    _,
    _,
    _,
    permissions as never,
    _,
    _,
    _,
    _,
    commits as never,
  );
  Object.assign(svc, {
    toSummary: async (d: Doc) => d,
    applyTemplate: async (dto: unknown) => ({ dto, template: null }),
  });

  /** Every page's path is its parent's path plus its own id: no cycle, no stale child. */
  const consistent = () =>
    [...docs.values()].every((d) => d.path === `${d.parentId ? docs.get(d.parentId)!.path : '/'}${d.id}/`);
  return { svc, docs, revisions, consistent };
}

describe('#807 tree writes read the tree under the lock', () => {
  it('two crossed moves: one lands, the other is refused as a cycle', async () => {
    const r = rig([{ id: 'A' }, { id: 'B', position: 1 }]);
    const results = await Promise.allSettled([
      r.svc.moveDocument('A', { parentId: 'B' } as never),
      r.svc.moveDocument('B', { parentId: 'A' } as never),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 400 });
    expect(r.consistent()).toBe(true);
    for (const d of r.docs.values()) expect(d.path.split(`/${d.id}/`)).toHaveLength(2);
  });

  it('the same crossed pair through PATCH parentId', async () => {
    const r = rig([{ id: 'A' }, { id: 'B', position: 1 }]);
    const results = await Promise.allSettled([
      r.svc.updateDocument('A', { parentId: 'B' } as never),
      r.svc.updateDocument('B', { parentId: 'A' } as never),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(r.consistent()).toBe(true);
  });

  it('a child created while its parent moves into a restricted page lands under the new path and its restriction', async () => {
    const r = rig([{ id: 'R', restricted: true }, { id: 'P', position: 1 }]);
    await Promise.all([
      r.svc.createDocument({ workspaceId: WS, projectId: 'p1', title: 'C', parentId: 'P' } as never, 'u1', { headless: true }),
      r.svc.moveDocument('P', { parentId: 'R' } as never),
    ]);
    const child = [...r.docs.values()].find((d) => d.title === 'C')!;
    expect(child.path).toBe(`/R/P/${child.id}/`);
    expect(child.restrictedBy).toContain('R');
    expect(r.consistent()).toBe(true);
  });

  it('two children created under one parent get distinct positions', async () => {
    const r = rig([{ id: 'P' }]);
    await Promise.all(
      ['C1', 'C2'].map((title) => r.svc.createDocument({ workspaceId: WS, projectId: 'p1', title, parentId: 'P' } as never, 'u1', { headless: true })),
    );
    const positions = [...r.docs.values()].filter((d) => d.parentId === 'P').map((d) => d.position);
    expect(positions.sort()).toEqual([0, 1]);
  });

  it('two reorders into one run end in an order one of them, run after the other, would give', async () => {
    const r = rig([{ id: 'A' }, { id: 'B', position: 1 }, { id: 'C', position: 2 }]);
    await Promise.all([
      r.svc.moveDocument('A', { parentId: null, beforeId: null } as never),
      r.svc.moveDocument('C', { parentId: null, beforeId: 'A' } as never),
    ]);
    const order = [...r.docs.values()].sort((a, b) => a.position - b.position).map((d) => d.id).join('');
    // A to the end then C before A: BCA. C before A then A to the end: CBA.
    expect(['BCA', 'CBA']).toContain(order);
  });

  it('two concurrent saves get distinct revision numbers', async () => {
    const r = rig([{ id: 'D' }]);
    const draft = (r.svc as unknown as { createDraftRevision: (id: string, o: object) => Promise<unknown> }).createDraftRevision.bind(r.svc);
    await Promise.all([draft('D', {}), draft('D', {})]);
    expect(r.revisions.sort()).toEqual([1, 2]);
  });
});
