import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service.js';

const DOC = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f00112233';
const PROJECT = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f70819203';

describe('myDraftBranch', () => {
  it('two tabs asking at once: the one whose insert loses answers with the branch that won', async () => {
    const winner = { id: 'b1', documentId: DOC, name: `draft/${USER}`, headRevisionId: 'r1', ownerId: USER, restricted: true };
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const prisma = {
      documentBranch: {
        findFirst,
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue({ headRevisionId: 'r1' }),
      },
      projectBranch: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    };
    const stub = {} as never;
    const service = new DocumentsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub);
    vi.spyOn(service as never, 'getDocumentOrThrow').mockResolvedValue({ id: DOC, projectId: PROJECT, defaultBranch: 'main' } as never);
    vi.spyOn(service, 'createBranch').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    vi.spyOn(service as never, 'toBranchInfo').mockImplementation(((b: { id: string }) => ({ branchId: b.id })) as never);

    await expect(service.myDraftBranch(DOC, USER)).resolves.toEqual({ branch: { branchId: 'b1' }, pages: [] });
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('any other failure is still thrown', async () => {
    const prisma = {
      documentBranch: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      projectBranch: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    };
    const stub = {} as never;
    const service = new DocumentsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub);
    vi.spyOn(service as never, 'getDocumentOrThrow').mockResolvedValue({ id: DOC, projectId: PROJECT, defaultBranch: 'main' } as never);
    vi.spyOn(service, 'createBranch').mockRejectedValue(new Error('db down'));
    await expect(service.myDraftBranch(DOC, USER)).rejects.toThrow('db down');
  });

  it('takes the first name free in the whole project, not just on this page (#636)', async () => {
    const prisma = {
      documentBranch: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ name: `draft/${USER}-3` }]),
      },
      // Another page spent `draft/<id>` and holds `-2`: reusing either would join its branch.
      projectBranch: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ name: `draft/${USER}` }, { name: `draft/${USER}-2` }]),
      },
    };
    const stub = {} as never;
    const service = new DocumentsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub);
    vi.spyOn(service as never, 'getDocumentOrThrow').mockResolvedValue({ id: DOC, projectId: PROJECT, defaultBranch: 'main' } as never);
    const create = vi.spyOn(service, 'createBranch').mockResolvedValue({ branch: { branchId: 'b9' } } as never);
    await service.myDraftBranch(DOC, USER);
    expect(create).toHaveBeenCalledWith(DOC, { name: `draft/${USER}-4`, visibility: 'private' }, USER);
    expect(prisma.projectBranch.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: PROJECT, name: { startsWith: `draft/${USER}` } } }));
  });

  function folding(inReview: number) {
    const live = { id: 'pb7', name: `draft/${USER}-2` };
    const prisma = {
      documentBranch: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([{ documentId: 'other-page' }]),
      },
      projectBranch: { findFirst: vi.fn().mockResolvedValue(live), findMany: vi.fn() },
      mergeRequest: { count: vi.fn().mockResolvedValue(inReview) },
    };
    const stub = {} as never;
    const service = new DocumentsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub);
    vi.spyOn(service as never, 'getDocumentOrThrow').mockResolvedValue({ id: DOC, projectId: PROJECT, defaultBranch: 'main' } as never);
    const create = vi.spyOn(service, 'createBranch').mockResolvedValue({ branch: { branchId: 'b9' } } as never);
    return { prisma, service, create };
  }

  it("a page not on the draft yet forks onto the caller's newest live one, and lists the draft's pages (#636)", async () => {
    const { prisma, service, create } = folding(0);
    await expect(service.myDraftBranch(DOC, USER)).resolves.toEqual({ branch: { branchId: 'b9' }, pages: ['other-page'] });
    expect(create).toHaveBeenCalledWith(DOC, { name: `draft/${USER}-2`, visibility: 'private' }, USER);
    expect(prisma.projectBranch.findMany).not.toHaveBeenCalled();
    // Never someone else's branch that happens to carry the caller's name.
    const { where } = prisma.projectBranch.findFirst.mock.calls[0][0];
    expect(where.branches).toMatchObject({ some: { ownerId: USER }, every: { ownerId: USER } });
  });

  it('a page joining a draft already in review is readable, as the rest of it is', async () => {
    const { service, create } = folding(1);
    await service.myDraftBranch(DOC, USER);
    expect(create).toHaveBeenCalledWith(DOC, { name: `draft/${USER}-2`, visibility: 'workspace' }, USER);
  });
});
