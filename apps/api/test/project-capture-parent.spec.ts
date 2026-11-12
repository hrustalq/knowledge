import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { CaptureService } from '../src/captures/capture.service.js';

/** A capture parent page per project (#924): project → workspace → the project root. */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A_PARENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const WS_PARENT = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const B_PAGE = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
const SCOPE = { workspaceId: 'ws', userId: 'u', role: 'editor', bypass: true, guest: false, readOnly: false, groupIds: new Set(), denied: new Set(), granted: new Set() };

function harness(opts: { projectParents?: Record<string, string | null>; pages?: Array<{ id: string; projectId: string; archivedAt?: Date | null }> }) {
  const parents = { ...opts.projectParents };
  const pages = opts.pages ?? [];
  const match = (where: { id: string | { in: string[] }; projectId: string }) =>
    pages.filter((d) => (typeof where.id === 'string' ? d.id === where.id : where.id.in.includes(d.id)) && d.projectId === where.projectId && !d.archivedAt);
  const prisma = {
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ captureParentDocumentId: parents[where.id] ?? null })),
      findUniqueOrThrow: vi.fn(async () => ({ workspaceId: 'ws' })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { captureParentDocumentId: string | null } }) => {
        parents[where.id] = data.captureParentDocumentId;
      }),
    },
    document: {
      findMany: vi.fn(async ({ where }: { where: never }) => match(where)),
      findFirst: vi.fn(async ({ where }: { where: never }) => match(where)[0] ?? null),
    },
  };
  const aiConfig = { captureSettings: vi.fn(async () => ({ parentDocumentId: WS_PARENT })) };
  const svc = new CaptureService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    aiConfig as never, {} as never, { get: () => 'https://kn.test' } as never,
  );
  return { svc, prisma };
}

describe('CaptureService.captureParent', () => {
  const pages = [
    { id: A_PARENT, projectId: A },
    { id: WS_PARENT, projectId: B },
  ];

  it("lands a capture in A under A's parent, and one in B where it lands today", async () => {
    const { svc } = harness({ projectParents: { [A]: A_PARENT }, pages });
    expect(await svc.captureParent(A, WS_PARENT)).toEqual({ workspace: WS_PARENT, project: A_PARENT, effective: A_PARENT, inherited: null, source: 'project' });
    expect(await svc.captureParent(B, WS_PARENT)).toEqual({ workspace: WS_PARENT, project: null, effective: WS_PARENT, inherited: WS_PARENT, source: 'workspace' });
    // The workspace's parent is a page of B, so A without its own falls to the project root — as before #924.
    expect((await harness({ pages }).svc.captureParent(A, WS_PARENT)).effective).toBeNull();
  });

  it('falls back rather than failing when the parent is deleted, archived or moved away', async () => {
    for (const gone of [[], [{ id: A_PARENT, projectId: A, archivedAt: new Date() }], [{ id: A_PARENT, projectId: B }]]) {
      const { svc } = harness({ projectParents: { [A]: A_PARENT }, pages: gone });
      expect(await svc.captureParent(A, null)).toEqual({ workspace: null, project: A_PARENT, effective: null, inherited: null, source: 'default' });
    }
  });

  it('refuses a page from another project, and clears on null', async () => {
    const { svc, prisma } = harness({ pages: [...pages, { id: B_PAGE, projectId: B }] });
    await expect(svc.setProjectCaptureParent(SCOPE as never, A, B_PAGE)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.project.update).not.toHaveBeenCalled();
    expect((await svc.setProjectCaptureParent(SCOPE as never, A, A_PARENT)).parentDocumentId).toMatchObject({ project: A_PARENT, source: 'project' });
    expect((await svc.setProjectCaptureParent(SCOPE as never, A, null)).parentDocumentId).toMatchObject({ project: null, effective: null });
  });
});
