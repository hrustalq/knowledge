import { describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service.js';
import { ProjectsService } from '../src/projects/projects.service.js';
import { systemScope } from '../src/permissions/access-scope.js';

// #642: a capture still behind its merge request is readable by id (its
// reviewer opens it from the MR) but is not a page any list, graph or count shows.

const WS = '11111111-1111-4111-8111-111111111111';
const scope = systemScope(WS);

type Row = { id: string; title: string; pendingMergeRequestId: string | null };
const rows = (): Row[] => [
  { id: 'a', title: 'A', pendingMergeRequestId: null },
  { id: 'b', title: 'B', pendingMergeRequestId: null },
  { id: 'cap', title: 'Captured', pendingMergeRequestId: 'mr-1' },
];

/** Applies just the `pendingMergeRequestId` and `id` parts of a where, which is all this spec is about. */
function matches(r: Row, where: Record<string, unknown> = {}): boolean {
  const pending = where.pendingMergeRequestId as null | { not: null } | undefined;
  if (pending === null && r.pendingMergeRequestId !== null) return false;
  if (pending && r.pendingMergeRequestId === null) return false;
  const id = where.id as { not?: string } | undefined;
  if (id?.not && r.id === id.not) return false;
  return true;
}

function documents(docs: Row[]) {
  const edges = docs.map((d) => ({ documentId: d.id, targetKey: 'service:billing', type: 'MENTIONS', extractor: 'test', confidence: 1 }));
  const prisma = {
    document: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        docs.filter((d) => matches(d, where)).map((d) => ({ ...d, defaultBranch: 'main', category: null, branches: [] })),
      ),
    },
    documentRevision: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const graph = {
    getWorkspaceRelationGraph: vi.fn().mockResolvedValue({ edges, entities: {}, documents: {} }),
  };
  const permissions = { documentFilterFor: vi.fn().mockResolvedValue({}) };
  const s = {} as never;
  const service = new DocumentsService(prisma as never, s, graph as never, s, s, s, s, s, s, s, permissions as never, s, s, s, s, s);
  vi.spyOn(service as never, 'getDocumentOrThrow').mockImplementation((async (id: string) => ({ id, workspaceId: WS })) as never);
  return service;
}

const pageIds = (nodes: { id: string; kind: string }[]) => nodes.filter((n) => n.kind === 'document').map((n) => n.id).sort();

describe('the workspace graph', () => {
  it('has no node and no edge for a capture behind its merge request', async () => {
    const g = await documents(rows()).getWorkspaceGraph(scope);
    expect(pageIds(g.nodes)).toEqual(['a', 'b']);
    expect(g.edges.map((e) => e.from)).not.toContain('cap');
  });

  it('draws it once the merge clears the pending mark', async () => {
    const merged = rows().map((r) => ({ ...r, pendingMergeRequestId: null }));
    expect(pageIds((await documents(merged).getWorkspaceGraph(scope)).nodes)).toEqual(['a', 'b', 'cap']);
  });
});

describe('a page graph', () => {
  it('does not walk to a pending neighbour', async () => {
    const g = await documents(rows()).getDocumentGraph('a', 1, scope);
    expect(pageIds(g.nodes)).toEqual(['a', 'b']);
  });

  it('still opens for the pending page itself, so its reviewer sees it', async () => {
    const g = await documents(rows()).getDocumentGraph('cap', 1, scope);
    expect(pageIds(g.nodes)).toEqual(['a', 'b', 'cap']);
  });
});

describe('project page counts', () => {
  it('count only listed pages, in the list, one project and after an edit', async () => {
    const project = { id: 'p1', workspaceId: WS, name: 'P', createdAt: new Date(), updatedAt: new Date(), _count: { documents: 0 } };
    const prisma = {
      project: {
        findMany: vi.fn().mockResolvedValue([project]),
        findUnique: vi.fn().mockResolvedValue(project),
        update: vi.fn().mockResolvedValue(project),
      },
    };
    const s = {} as never;
    const service = new ProjectsService(prisma as never, { record: vi.fn() } as never, s, s);
    vi.spyOn(service as never, 'requireProject').mockResolvedValue(project as never);

    await service.list({ workspaceId: WS } as never, scope);
    await service.get('p1', scope);
    await service.update('p1', { name: 'Q' } as never);

    const counted = [prisma.project.findMany, prisma.project.findUnique, prisma.project.update].map(
      (fn) => (fn.mock.calls[0]![0] as { include: { _count: { select: { documents: { where: Record<string, unknown> } } } } })
        .include._count.select.documents.where,
    );
    for (const where of counted) expect(where).toMatchObject({ pendingMergeRequestId: null });
  });
});
