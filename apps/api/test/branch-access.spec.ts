import { describe, expect, it } from 'vitest';
import { branchLevel } from '../src/permissions/branch-access.js';
import { branchRefsOf } from '../src/auth/acl.guard.js';
import type { AccessIdentity } from '../src/permissions/access-scope.js';

/** #474 phase 2: who reads and writes a private branch, and which request keys name one. */
const who = (over: Partial<AccessIdentity> = {}): AccessIdentity => ({
  userId: 'u-bob',
  role: 'editor',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  ...over,
});
const priv = { id: 'b-1', ownerId: 'u-alice', restricted: true };
const grant = (subjectType: 'user' | 'group', subjectId: string, level: 'view' | 'edit') => ({
  resourceId: 'b-1',
  subjectType,
  subjectId,
  level,
});

describe('branchLevel', () => {
  it('adds nothing to an open branch: the page decides', () => {
    expect(branchLevel(who(), { ...priv, restricted: false }, [])).toBe('edit');
  });

  it('lets in the owner and admins, and nobody else without a grant', () => {
    expect(branchLevel(who({ userId: 'u-alice' }), priv, [])).toBe('edit');
    expect(branchLevel(who({ bypass: true }), priv, [])).toBe('edit');
    expect(branchLevel(who(), priv, [])).toBe('none');
    expect(branchLevel(who(), priv, [grant('user', 'u-carol', 'edit')])).toBe('none');
  });

  it('reads the grant to the person or one of their groups, highest first', () => {
    expect(branchLevel(who(), priv, [grant('user', 'u-bob', 'view')])).toBe('view');
    expect(branchLevel(who({ groupIds: new Set(['g-1']) }), priv, [grant('user', 'u-bob', 'view'), grant('group', 'g-1', 'edit')])).toBe(
      'edit',
    );
    expect(branchLevel(who(), priv, [{ ...grant('user', 'u-bob', 'edit'), resourceId: 'b-2' }])).toBe('none');
  });

  it('caps a read-only key at view, owner included', () => {
    expect(branchLevel(who({ userId: 'u-alice', readOnly: true }), priv, [])).toBe('view');
  });
});

describe('branchRefsOf', () => {
  const rev = '11111111-1111-4111-8111-111111111111';
  const branchId = '22222222-2222-4222-8222-222222222222';

  it('collects branch names, branch ids and revision ids from params, query and body', () => {
    expect(
      branchRefsOf({
        params: { id: 'doc', revisionId: rev, branchId },
        query: { branch: 'draft/u', from: rev, to: 'not-a-uuid' },
        body: { sourceBranch: 'feature', fromRevisionId: rev },
      }),
    ).toEqual({ branchNames: ['draft/u', 'feature'], branchIds: [branchId], revisionIds: [rev, rev, rev] });
  });

  it('names nothing on a request that names nothing', () => {
    expect(branchRefsOf({ params: { id: 'doc' }, query: {}, body: {} })).toEqual({ branchNames: [], branchIds: [], revisionIds: [] });
  });
});
