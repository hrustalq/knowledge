import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service.js';

const DOC = '6f1c2d3e-4a5b-4c6d-8e7f-001122334455';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f00112233';

describe('myDraftBranch', () => {
  it('two tabs asking at once: the one whose insert loses answers with the branch that won', async () => {
    const winner = { id: 'b1', documentId: DOC, name: `draft/${USER}`, headRevisionId: 'r1', ownerId: USER, restricted: true };
    const findFirst = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    const prisma = {
      documentBranch: {
        findFirst,
        count: vi.fn().mockResolvedValue(0),
        findUnique: vi.fn().mockResolvedValue({ headRevisionId: 'r1' }),
      },
    };
    const stub = {} as never;
    const service = new DocumentsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub);
    vi.spyOn(service as never, 'getDocumentOrThrow').mockResolvedValue({ id: DOC, defaultBranch: 'main' } as never);
    vi.spyOn(service, 'createBranch').mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    vi.spyOn(service as never, 'toBranchInfo').mockImplementation(((b: { id: string }) => ({ branchId: b.id })) as never);

    await expect(service.myDraftBranch(DOC, USER)).resolves.toEqual({ branch: { branchId: 'b1' } });
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('any other failure is still thrown', async () => {
    const prisma = { documentBranch: { findFirst: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) } };
    const stub = {} as never;
    const service = new DocumentsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub, stub);
    vi.spyOn(service as never, 'getDocumentOrThrow').mockResolvedValue({ id: DOC, defaultBranch: 'main' } as never);
    vi.spyOn(service, 'createBranch').mockRejectedValue(new Error('db down'));
    await expect(service.myDraftBranch(DOC, USER)).rejects.toThrow('db down');
  });
});
