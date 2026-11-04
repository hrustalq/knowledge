import { describe, expect, it, vi } from 'vitest';
import { GitPushService } from '../src/git/git-push.service.js';
import { systemScope } from '../src/permissions/access-scope.js';

// #737: a push that reaches no merge request is accepted and says so.
const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const commit = { subject: 'Late fix', changes: [{ documentId: 'doc-1' }] };

function notice(rows: { open?: object | null; latest?: object | null; options?: string[]; created?: string[]; heads?: object[] }) {
  const prisma = {
    mergeRequest: {
      findFirst: vi.fn(async ({ where }: { where: { status?: string } }) => (where.status === 'open' ? (rows.open ?? null) : (rows.latest ?? null))),
      update: vi.fn(async () => ({})),
    },
    documentBranch: { findMany: vi.fn(async () => rows.heads ?? [{ documentId: 'doc-1', revisions: [{ id: 'r' }] }]) },
    document: { updateMany: vi.fn(async () => ({})) },
  };
  const mergeRequests = { create: vi.fn(async () => ({ mergeRequest: { mergeRequestId: 'mr-new', title: 'Late fix' } })) };
  const commits = { projectBranch: vi.fn(async () => 'pb-1') };
  const config = { get: (key: string) => ({ GIT_CACHE_DIR: '/tmp/x', WEB_BASE_URL: 'https://kn.test/' })[key] };
  const service = new GitPushService(prisma as never, {} as never, {} as never, {} as never, {} as never, mergeRequests as never, commits as never, {} as never, {} as never, {} as never, config as never);
  const lines = (service as unknown as { openMergeRequest: (...args: unknown[]) => Promise<string[]> }).openMergeRequest(
    PROJECT,
    'fix-terms',
    [commit],
    rows.created ?? [],
    rows.options ?? [],
    USER,
    systemScope(WS),
  );
  return { lines, mergeRequests };
}

describe('a push with no merge request to reach', () => {
  it('names the merged merge request of the branch', async () => {
    const { lines, mergeRequests } = notice({ latest: { id: 'mr-1', title: 'Fix terms', status: 'merged' } });
    expect(await lines).toEqual(['error.git.push.branchMerged']);
    expect(mergeRequests.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a branch that never had one', null],
    ['a branch whose latest was closed', { id: 'mr-1', title: 'Fix terms', status: 'closed' }],
  ])('says none carries them on %s', async (_name, latest) => {
    expect(await notice({ latest }).lines).toEqual(['error.git.push.noMergeRequest']);
  });

  it('still reports the open merge request it updated', async () => {
    expect(await notice({ open: { id: 'mr-2', title: 'Fix terms' } }).lines).toEqual(['error.git.push.mrUpdated']);
  });

  it('still opens one on -o merge_request.create', async () => {
    const { lines, mergeRequests } = notice({ options: ['merge_request.create'], latest: { id: 'mr-1', title: 'Fix terms', status: 'merged' } });
    expect(await lines).toEqual(['error.git.push.mrCreated']);
    expect(mergeRequests.create).toHaveBeenCalledOnce();
  });

  it('says so when asked to open one and no page has anything to anchor it', async () => {
    const { lines, mergeRequests } = notice({ options: ['merge_request.create'], heads: [] });
    expect(await lines).toEqual(['error.git.push.noMergeRequest']);
    expect(mergeRequests.create).not.toHaveBeenCalled();
  });
});
