import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MergeRequestsService } from '../src/documents/merge-requests.service.js';
import { LintChecksService } from '../src/documents/lint/lint-checks.service.js';
import { sourcePages } from '../src/documents/mr-pages.js';

// #636 phase 1b-2a: a merge request spans every page its project branch changed.
const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const MR = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER = { userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', mode: 'api-key' } as never;

const branch = (documentId: string, name: string, head: string | null, extra: Record<string, unknown> = {}) => ({
  id: `${name}-${documentId[0]}`,
  documentId,
  name,
  headRevisionId: head,
  projectBranchId: name === 'fix' ? PB : null,
  protected: false,
  ...extra,
});

function fixture(over: { mergeBaseOfB?: string; denyB?: boolean } = {}) {
  const source = [branch(A, 'fix', 'a-src'), branch(B, 'fix', 'b-src')];
  const target = [branch(A, 'main', 'a-main'), branch(B, 'main', 'b-main')];
  const mr = {
    id: MR,
    documentId: A,
    title: 'Fix terms',
    status: 'open',
    isDraft: false,
    authorId: USER,
    approvedBy: [],
    sourceBranch: source[0],
    targetBranch: target[0],
    reviewers: [],
  };
  const prisma = {
    mergeRequest: { findUnique: vi.fn(async () => mr) },
    documentBranch: {
      findMany: vi.fn(async ({ where }: { where: { name?: string } }) => (where.name ? target : source)),
    },
    document: {
      findUniqueOrThrow: vi.fn(async () => ({ workspaceId: WS, projectId: PROJECT })),
      findMany: vi.fn(async () => {
        throw new Error('past the gates');
      }),
    },
  };
  const compare = {
    findMergeBase: vi.fn(async (doc: string) => (doc === A ? 'a-main' : (over.mergeBaseOfB ?? 'b-main'))),
  };
  const permissions = {
    scopeFor: vi.fn(async () => ({ workspaceId: WS })),
    requireLevel: vi.fn(async (_scope: unknown, resource: { id: string }) => {
      if (over.denyB && resource.id === B) throw new ForbiddenException();
      return 'edit';
    }),
  };
  const lint = { gate: vi.fn(async () => ({ blocked: false })) };
  const service = new MergeRequestsService(
    prisma as never,
    {} as never, // storage
    {} as never, // documents
    compare as never,
    {} as never, // activity
    {} as never, // access
    { get: () => 0 } as never,
    {} as never, // notifications
    {} as never, // events
    permissions as never,
    {} as never, // apiDiffs
    {} as never, // entities
    lint as never,
  );
  return { service, permissions };
}

describe('multi-page merge requests', () => {
  it('lists the page it was opened from first', async () => {
    const rows = [branch(A, 'fix', 'a'), branch(B, 'fix', 'b')];
    const prisma = { documentBranch: { findMany: vi.fn(async () => rows) } };
    const opened = rows[1];
    const pages = await sourcePages(prisma as never, opened);
    expect(pages.map((p) => p.documentId)).toEqual([B, A]);
    expect(prisma.documentBranch.findMany).toHaveBeenCalledWith({
      where: { projectBranchId: PB, OR: [{ id: opened.id }, { revisions: { some: { status: { not: 'draft' } } } }] },
      orderBy: { documentId: 'asc' },
    });
  });

  it('refuses diverged on the page whose target moved, by its id', async () => {
    const f = fixture({ mergeBaseOfB: 'b-old' });
    const error = await f.service.merge(MR, 'merge-commit', USER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ reason: 'diverged', documentId: B, currentHeadRevisionId: 'b-main' });
  });

  it('needs edit on every page, not only the one the guard checked', async () => {
    const f = fixture({ denyB: true });
    await expect(f.service.merge(MR, 'merge-commit', USER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.permissions.requireLevel).toHaveBeenCalledWith(expect.anything(), { type: 'document', id: B }, 'edit');
    expect(f.permissions.requireLevel).not.toHaveBeenCalledWith(expect.anything(), { type: 'document', id: A }, 'edit');
  });

  it('passes every gate with both pages fast-forward', async () => {
    await expect(fixture().service.merge(MR, 'merge-commit', USER)).rejects.toThrow('past the gates');
  });

  it("holds the lint gate on a second page's head that has no check yet", async () => {
    const check = { id: 'c-a', mergeRequestId: MR, kind: 'lint', headRevisionId: 'a-src', status: 'passed', createdAt: new Date() };
    const prisma = {
      mergeRequest: {
        findUnique: vi.fn(async () => ({ id: MR, sourceBranch: branch(A, 'fix', 'a-src'), document: { workspaceId: WS, projectId: PROJECT } })),
      },
      documentBranch: { findMany: vi.fn(async () => [branch(A, 'fix', 'a-src'), branch(B, 'fix', 'b-src')]) },
      mergeRequestCheck: { findMany: vi.fn(async () => [check]) },
      agentRun: { findMany: vi.fn(async () => []) },
      mergeRequestThread: { groupBy: vi.fn(async () => []) },
      workspaceSettings: { findUnique: vi.fn(async () => ({ lintPolicy: 'block' })) },
      project: { findFirst: vi.fn(async () => ({ lintPolicy: null })) },
    };
    const service = new LintChecksService(prisma as never, { resolve: async () => ({ enabled: true }) } as never, { get: () => 'block' } as never);
    const listed = await service.list(MR, true);
    expect(listed.gate).toMatchObject({ blocked: true, checkStatus: 'missing' });
    expect(listed.checks[0]).toMatchObject({ checkId: 'c-a', current: true });
  });
});
