import { describe, expect, it, vi } from 'vitest';
import { MergeRequestsService } from '../src/documents/merge-requests.service.js';
import { systemScope } from '../src/permissions/access-scope.js';

// #743: nothing deletes a merged branch, so a project's list narrows instead.
const PROJECT = '22222222-2222-4222-8222-222222222222';
const scope = systemScope('11111111-1111-4111-8111-111111111111');
const _ = {} as never;

function service() {
  const rows = Array.from({ length: 80 }, (_x, i) => ({
    id: `branch-${i}`,
    name: `fix-${i}`,
    ownerId: null,
    restricted: false,
    documentId: `doc-${i}`,
    projectBranchId: `pb-${i}`,
    document: { title: `Page ${i}`, defaultBranch: 'main' },
  }));
  const documentBranch = { findMany: vi.fn(async () => rows) };
  const prisma = {
    documentBranch,
    documentRevision: { findMany: vi.fn(async () => []) },
    mergeRequest: {
      findMany: vi.fn(async () => [
        { id: 'mr-3', title: 'Three', isDraft: false, sourceBranchId: 'branch-3' },
        { id: 'mr-7', title: 'Seven', isDraft: true, sourceBranchId: 'branch-7' },
      ]),
    },
  };
  const permissions = { readableBranchIds: vi.fn(async (_s: unknown, list: { id: string }[]) => new Set(list.map((b) => b.id))) };
  const svc = new MergeRequestsService(prisma as never, _, _, _, _, _, { get: () => 0 } as never, _, _, permissions as never, _, _, _);
  return { svc, documentBranch };
}

describe('projectBranches', () => {
  it('returns every branch with no filter, as the web asks', async () => {
    const { svc } = service();
    expect((await svc.projectBranches(PROJECT, scope)).branches).toHaveLength(80);
  });

  it('keeps only branches with an open merge request', async () => {
    const { svc } = service();
    const { branches } = await svc.projectBranches(PROJECT, scope, { openOnly: true });
    expect(branches.map((b) => b.name).sort()).toEqual(['fix-3', 'fix-7']);
    expect(branches.every((b) => b.openMergeRequest)).toBe(true);
  });

  it('filters by name in the query, case-insensitively', async () => {
    const { svc, documentBranch } = service();
    await svc.projectBranches(PROJECT, scope, { name: 'Capture/' });
    expect(documentBranch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ name: { contains: 'Capture/', mode: 'insensitive' } }) }),
    );
  });
});
