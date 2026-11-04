import { describe, expect, it, vi } from 'vitest';
import { DocumentsService } from '../src/documents/documents.service.js';

// #741: a page whose content lands on a branch has no first draft on its default branch.
const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const _ = {} as never;

function service() {
  const prisma = {
    withTransaction: (fn: () => Promise<unknown>) => fn(),
    onCommit: (fn: () => unknown) => fn(),
    document: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: data.id, workspaceId: WS, projectId: PROJECT })),
    },
    documentBranch: { create: vi.fn(async () => ({ id: 'branch-main' })) },
    documentRevision: {
      create: vi.fn(async () => ({ id: 'rev-1' })),
      update: vi.fn(async () => ({})),
    },
  };
  const storage = { revisionObjectKey: () => 'k', sourceObjectName: () => 'source.md' };
  const activity = { record: vi.fn(async () => undefined) };
  const projects = { requireProjectInWorkspace: vi.fn(async () => undefined) };
  const notifications = { ensureSubscription: vi.fn(async () => undefined) };
  const permissions = { recomputeRestrictedBy: vi.fn(async () => undefined) };
  const commits = { lock: vi.fn(async () => undefined), uniqueSlug: vi.fn(async () => 'slug'), projectBranch: vi.fn(async () => 'pb') };
  const svc = new DocumentsService(prisma as never, storage as never, _, _, activity as never, projects as never, notifications as never, _, _, _, permissions as never, _, _, _, _, commits as never);
  return { svc, prisma };
}

const page = { workspaceId: WS, projectId: PROJECT, title: 'A page' };

describe('createDocument', () => {
  it('head-less: a default branch with no head and no revision on it', async () => {
    const { svc, prisma } = service();
    const res = await svc.createDocument(page, USER, { headless: true });
    expect(prisma.documentBranch.create).toHaveBeenCalledOnce();
    expect(prisma.documentRevision.create).not.toHaveBeenCalled();
    expect(res).toEqual({ documentId: expect.any(String) });
  });

  it('otherwise: the draft revision an upload writes to, as before', async () => {
    const { svc, prisma } = service();
    const res = await svc.createDocument(page, USER);
    expect(prisma.documentRevision.create).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ revisionId: 'rev-1', branch: 'main', status: 'draft' });
  });
});
