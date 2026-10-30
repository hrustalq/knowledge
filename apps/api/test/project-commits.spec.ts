import { describe, expect, it, vi } from 'vitest';
import { ProjectCommitsService } from '../src/git/project-commits.service.js';

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';
const PARENT = '44444444-4444-4444-8444-444444444444';
const ANNA = '55555555-5555-4555-8555-555555555555';
const BOB = '66666666-6666-4666-8666-666666666666';

function harness(opts: { head?: string | null; drafts?: string[]; commitOf?: Record<string, string> } = {}) {
  const create = vi.fn(async () => ({}));
  const prisma = {
    $executeRaw: vi.fn(async () => 0),
    documentRevision: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: 'rev-2',
        authorId: ANNA,
        message: 'Fix the intro  \n',
        finalizedAt: new Date('2026-10-30T12:00:00.900Z'),
        coAuthorIds: [ANNA, BOB, BOB],
        branch: { name: 'fix' },
        parents: [{ parentRevisionId: 'rev-1' }],
        document: {
          id: DOC,
          workspaceId: WS,
          projectId: PROJECT,
          parentId: PARENT,
          path: `/${PARENT}/${DOC}/`,
          slug: 'архитектура',
          title: 'Архитектура',
          defaultBranch: 'main',
          draftOwnerId: null,
        },
      })),
    },
    document: {
      findMany: vi.fn(async () => (opts.drafts ?? []).map((id) => ({ id }))),
      count: vi.fn(async () => 0),
    },
    projectCommit: {
      findFirst: vi.fn(async () => (opts.head ? { id: opts.head } : null)),
      create,
    },
    projectCommitChange: {
      findFirst: vi.fn(async ({ where }: { where: { revisionId: string } }) => {
        const commitId = opts.commitOf?.[where.revisionId];
        return commitId ? { commitId } : null;
      }),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: ANNA, displayName: 'Анна <Петрова>' },
        { id: BOB, displayName: 'Bob Stone' },
      ]),
    },
  };
  const config = { get: () => 'example.org' };
  const svc = new ProjectCommitsService(prisma as never, config as never);
  const written = () => (create.mock.calls[0] as unknown as [{ data: Record<string, any> }])[0].data;
  return { svc, prisma, create, written };
}

describe('ProjectCommitsService', () => {
  it('writes a merge commit on the branch head, with frozen header bytes', async () => {
    const h = harness({ head: 'c-head', commitOf: { 'rev-src': 'c-src' } });
    await h.svc.recordRevision('rev-2', { mergedFrom: 'rev-src' });

    const data = h.written();
    expect(data).toMatchObject({ workspaceId: WS, projectId: PROJECT, branch: 'fix' });
    expect(data.parents.create).toEqual([
      { parentCommitId: 'c-head', parentOrder: 1 },
      { parentCommitId: 'c-src', parentOrder: 2 },
    ]);
    expect(data.changes.createMany.data).toEqual([
      { documentId: DOC, revisionId: 'rev-2', parentDocumentId: PARENT, slug: 'архитектура', removed: false },
    ]);
    const anna = `Анна Петрова <${ANNA}@users.noreply.example.org> 1793361600 +0000`;
    expect(Buffer.from(data.header).toString('utf8')).toBe(
      `author ${anna}\ncommitter ${anna}\n\nFix the intro\n\nCo-authored-by: Bob Stone <${BOB}@users.noreply.example.org>\n`,
    );
  });

  it("a branch's first commit forks from the commit that wrote its base revision", async () => {
    const h = harness({ head: null, commitOf: { 'rev-1': 'c-base' } });
    await h.svc.recordRevision('rev-2');
    expect(h.written().parents.create).toEqual([{ parentCommitId: 'c-base', parentOrder: 1 }]);
  });

  it('writes nothing for a page under a private draft', async () => {
    const h = harness({ head: 'c-head', drafts: [PARENT] });
    await h.svc.recordRevision('rev-2');
    expect(h.create).not.toHaveBeenCalled();
  });

  it('suffixes a slug a sibling already holds, case-folded, and keeps a suffix that still fits', async () => {
    const h = harness();
    h.prisma.document.count.mockResolvedValueOnce(1);
    expect(await h.svc.uniqueSlug(PROJECT, PARENT, DOC, 'Intro')).toBe('intro-33333333');
    expect(h.prisma.document.count).toHaveBeenCalledWith({
      where: { projectId: PROJECT, parentId: PARENT, id: { not: DOC }, slug: { equals: 'intro', mode: 'insensitive' } },
    });
    expect(await h.svc.uniqueSlug(PROJECT, PARENT, DOC, 'Intro', 'intro-33333333')).toBe('intro-33333333');
  });
});
