import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { DocumentsService } from '../src/documents/documents.service.js';
import { internalWrite, type WriteAuthority } from '../src/documents/write-authority.js';

/**
 * #958 phase 6: in a `review` workspace a person adds a revision to the
 * default branch of a published page only through a merge request, unless
 * they are a workspace admin. One predicate, asked where every revision is
 * created, so REST, MCP, an upload and a git push give the same refusal.
 */
const WS = '11111111-1111-4111-8111-111111111111';

type Page = { draftOwnerId?: string | null; pendingMergeRequestId?: string | null };
type Branch = { name?: string; headRevisionId?: string | null };

function rig(mode: 'review' | 'direct', admin = false) {
  const editing = { policy: vi.fn(async () => ({ publishMode: { effective: mode } })) };
  const permissions = { scopeFor: vi.fn(async () => ({ bypass: admin })) };
  const svc = Object.assign(Object.create(DocumentsService.prototype) as DocumentsService, { editing, permissions });
  const check = (by: WriteAuthority, page: Page = {}, branch: Branch = {}) =>
    (svc as unknown as { assertMayWrite: (d: unknown, b: unknown, by: WriteAuthority) => Promise<void> }).assertMayWrite(
      { workspaceId: WS, defaultBranch: 'main', draftOwnerId: null, pendingMergeRequestId: null, ...page },
      { name: 'main', headRevisionId: 'r1', ...branch },
      by,
    );
  return { check, editing, permissions };
}

const editor = { person: { userId: 'u1', mode: 'api-key' } } as WriteAuthority;

describe('a direct write to a published page (#958)', () => {
  it('review: a non-admin editor is refused with a reason and no title', async () => {
    const e = await rig('review').check(editor).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ConflictException);
    expect((e as ConflictException).getResponse()).toEqual({ statusCode: 409, message: expect.any(String), reason: 'review-required' });
  });

  it('review: a workspace admin writes', async () => {
    await expect(rig('review', true).check(editor)).resolves.toBeUndefined();
  });

  it('direct: any editor writes', async () => {
    const r = rig('direct');
    await expect(r.check(editor)).resolves.toBeUndefined();
    expect(r.permissions.scopeFor).not.toHaveBeenCalled();
  });

  it('review: a branch other than the default is never held, so Publish through a merge request works', async () => {
    const r = rig('review');
    await expect(r.check(editor, {}, { name: 'draft/u1' })).resolves.toBeUndefined();
    expect(r.editing.policy).not.toHaveBeenCalled();
  });

  it('review: a merge, a connector sync and a proposal write whoever started them', async () => {
    const r = rig('review');
    for (const reason of ['merge', 'connector-sync', 'proposal'] as const) await expect(r.check(internalWrite(reason))).resolves.toBeUndefined();
    expect(r.editing.policy).not.toHaveBeenCalled();
  });

  it('review: a private draft page is its author\'s, and the first revision of a page that has none lands', async () => {
    const r = rig('review');
    await expect(r.check(editor, { draftOwnerId: 'u1' })).resolves.toBeUndefined();
    await expect(r.check(editor, {}, { headRevisionId: null })).resolves.toBeUndefined();
  });

  it('review: a page still behind its merge request takes no first revision past it', async () => {
    await expect(rig('review').check(editor, { pendingMergeRequestId: 'mr1' }, { headRevisionId: null })).rejects.toBeInstanceOf(ConflictException);
  });

  it('the dev principal and the principal-less stdio server pass, as every other check lets them', async () => {
    const r = rig('review');
    await expect(r.check({ person: undefined })).resolves.toBeUndefined();
    await expect(r.check({ person: { userId: 'u', mode: 'dev' } } as WriteAuthority)).resolves.toBeUndefined();
  });
});
