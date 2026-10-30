import { describe, expect, it, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  activityKindFor,
  HEALTH_FILTERS,
  isInactive,
  notificationCategoryFor,
  notificationReasonRank,
  TRUST_WEIGHTS,
  trustWeight,
  verificationIsStale,
  verificationStateFor,
} from '@knowledge/contracts';
import { expiryFor } from '../src/verification/verification-policy.service.js';
import { VerificationService } from '../src/verification/verification.service.js';
import { healthFilterSql, KnowledgeHealthService } from '../src/verification/knowledge-health.service.js';

/**
 * Page verification, ownership, freshness and archive (docs/features/39 + 40,
 * issue #66): the derived predicate, the ranking weight, the guarded
 * transitions and the bulk path's tenant check.
 */

const WS = '11111111-1111-4111-8111-111111111111';
/** A member who sees every page: the visibility predicate itself is pinned in permissions.spec.ts. */
const SCOPE = {
  workspaceId: WS,
  userId: 'u-1',
  role: 'editor' as const,
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set<string>(),
  denied: new Set<string>(),
  granted: new Set<string>(),
};
const NOW = new Date('2026-10-11T12:00:00Z');
const day = 86_400_000;
const settings = { reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40, trustRanking: true };

describe('verificationStateFor (docs/features/39)', () => {
  const stamped = { verifiedRevisionId: 'r2', verificationExpiresAt: new Date(NOW.getTime() + 10 * day) };

  it('derives every state from the stamp, the flag, the head and the clock, in precedence order', () => {
    expect(verificationStateFor({ verifiedRevisionId: null }, 'r2', 0, NOW)).toBe('unverified');
    expect(verificationStateFor(stamped, 'r2', 0, NOW)).toBe('verified');
    expect(verificationStateFor(stamped, 'r3', 0, NOW)).toBe('edited');
    expect(verificationStateFor({ ...stamped, verificationExpiresAt: new Date(NOW.getTime() - 1) }, 'r2', 0, NOW)).toBe('expired');
    // Never expires.
    expect(verificationStateFor({ verifiedRevisionId: 'r2', verificationExpiresAt: null }, 'r2', 0, NOW)).toBe('verified');
    // A requested flag outranks the stamp; an open report outranks the request; outdated outranks everything.
    expect(verificationStateFor({ ...stamped, verificationFlag: 'requested' }, 'r2', 0, NOW)).toBe('requested');
    expect(verificationStateFor({ ...stamped, verificationFlag: 'requested' }, 'r2', 1, NOW)).toBe('flagged');
    expect(verificationStateFor({ ...stamped, verificationFlag: 'outdated' }, 'r2', 1, NOW)).toBe('outdated');
    expect(verificationStateFor({ verifiedRevisionId: null, verificationFlag: 'outdated' }, null, 0, NOW)).toBe('outdated');
  });

  it('changes with no write: the same row reads differently as the clock and the head move', () => {
    const row = { verifiedRevisionId: 'r2', verificationExpiresAt: new Date('2026-12-01T00:00:00Z') };
    expect(verificationStateFor(row, 'r2', 0, new Date('2026-11-01T00:00:00Z'))).toBe('verified');
    expect(verificationStateFor(row, 'r2', 0, new Date('2026-12-02T00:00:00Z'))).toBe('expired');
    expect(verificationStateFor(row, 'r9', 0, new Date('2026-11-01T00:00:00Z'))).toBe('edited');
  });

  it('names the states under which the stamp no longer vouches for the page', () => {
    expect(['edited', 'expired', 'outdated'].every((s) => verificationIsStale(s as never))).toBe(true);
    expect(['verified', 'requested', 'flagged', 'unverified'].some((s) => verificationIsStale(s as never))).toBe(false);
  });
});

describe('trust weight, inactivity and expiry arithmetic', () => {
  it('orders verified > unverified/requested/edited > expired/flagged > outdated, with inactivity on top', () => {
    expect(trustWeight('verified', false)).toBeGreaterThan(trustWeight('unverified', false));
    expect(trustWeight('unverified', false)).toBe(trustWeight('requested', false));
    expect(trustWeight('unverified', false)).toBe(trustWeight('edited', false));
    expect(trustWeight('edited', false)).toBeGreaterThan(trustWeight('expired', false));
    expect(trustWeight('expired', false)).toBeGreaterThan(trustWeight('outdated', false));
    expect(trustWeight('verified', true)).toBeCloseTo(TRUST_WEIGHTS.verified * TRUST_WEIGHTS.inactive);
    // A verified page must not beat a clearly more relevant unverified one.
    expect(TRUST_WEIGHTS.verified).toBeLessThan(1.25);
  });

  it('isInactive reads the window; 0 disables it', () => {
    expect(isInactive(new Date(NOW.getTime() - 181 * day), 180, NOW)).toBe(true);
    expect(isInactive(new Date(NOW.getTime() - 179 * day), 180, NOW)).toBe(false);
    expect(isInactive(new Date(NOW.getTime() - 999 * day), 0, NOW)).toBe(false);
    expect(isInactive(null, 180, NOW)).toBe(false);
  });

  it('expiryFor: own interval beats the workspace default, 0 means never', () => {
    expect(expiryFor(NOW, 30, 90)).toEqual(new Date(NOW.getTime() + 30 * day));
    expect(expiryFor(NOW, null, 90)).toEqual(new Date(NOW.getTime() + 90 * day));
    expect(expiryFor(NOW, 0, 90)).toBeNull();
    expect(expiryFor(NOW, null, 0)).toBeNull();
  });
});

describe('vocabularies the feature joins', () => {
  it('files verification acts under curate and the owner reason between author and assigned', () => {
    for (const a of ['document.verified', 'document.outdated', 'document.archived', 'document.owner-changed']) {
      expect(activityKindFor(a), a).toBe('curate');
    }
    expect(activityKindFor('document.updated')).toBe('write');
    expect(notificationReasonRank('owner')).toBeGreaterThan(notificationReasonRank('author'));
    expect(notificationReasonRank('owner')).toBeLessThan(notificationReasonRank('assigned'));
  });

  it('routes the directed events to the verification category and keeps the feed-only ones out of inboxes', () => {
    for (const type of [
      'document.verification-requested',
      'document.outdated',
      'document.verification-expiring',
      'document.verification-expired',
      'document.owner-changed',
    ]) {
      expect(notificationCategoryFor(type), type).toBe('verification');
    }
    expect(notificationCategoryFor('document.verified')).toBeNull();
    expect(notificationCategoryFor('document.archived')).toBeNull();
  });

  it('has a SQL clause for every health filter', () => {
    const since = new Date(NOW.getTime() - 90 * 86_400_000);
    for (const f of HEALTH_FILTERS) expect(healthFilterSql(f, settings, NOW, since).sql, f).toContain('r.');
    expect(healthFilterSql(undefined, settings, NOW, since).sql).toContain('archived_at IS NULL');
    expect(healthFilterSql('archived', settings, NOW, since).sql).toContain('IS NOT NULL');
    // Inactivity off: the clause can never match.
    expect(healthFilterSql('inactive', { ...settings, inactiveAfterDays: 0 }, NOW, since).sql).toContain('false');
    // Read filters (#79): unread is gated on coverage; dead is unread and never surfaced by search.
    expect(healthFilterSql('unread', settings, NOW, since).sql).toContain('r.reads_covered');
    expect(healthFilterSql('unread', settings, NOW, since).sql).not.toContain('surfaced');
    expect(healthFilterSql('dead', settings, NOW, since).sql).toContain('NOT r.surfaced');
  });
});

// ------------------------------------------------------------------ service

function doc(over: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    workspaceId: WS,
    projectId: 'p-1',
    title: 'Billing',
    defaultBranch: 'main',
    path: '/doc-0/doc-1/',
    verifiedAt: null,
    verifiedBy: null,
    verifiedRevisionId: null,
    verificationFlag: null,
    verificationNote: null,
    ownerId: 'owner-1',
    reviewIntervalDays: null,
    archivedAt: null,
    branches: [{ name: 'main', headRevisionId: 'r2' }],
    ...over,
  };
}

function harness(row: Record<string, unknown>, updateCount = 1) {
  const prisma = {
    document: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: updateCount })),
      findMany: vi.fn(async () => []),
    },
    withTransaction: <T>(fn: () => Promise<T>) => fn(),
  };
  const commits = { lock: vi.fn(async () => undefined), recordState: vi.fn(async () => undefined) };
  const activity = { record: vi.fn(async () => undefined) };
  const notifications = { notify: vi.fn(async () => []) };
  const policy = { effective: vi.fn(async () => settings) };
  const documents = { getDocument: vi.fn(async () => ({ document: { documentId: 'doc-1' } })), setOwner: vi.fn(async () => ({})), breadcrumbsFor: vi.fn(async () => new Map()) };
  const svc = new VerificationService(prisma as never, activity as never, notifications as never, policy as never, documents as never, commits as never);
  return { svc, prisma, activity, notifications, documents, commits };
}

describe('VerificationService transitions', () => {
  it('verify stamps the head, computes the expiry from the workspace default, clears the flag and both sweeper stamps', async () => {
    const { svc, prisma, activity } = harness(doc({ verificationFlag: 'requested', verificationNote: 'check' }));
    await svc.verify('doc-1', 'u-1');
    const call = prisma.document.updateMany.mock.calls[0]![0] as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: 'doc-1', archivedAt: null });
    expect(call.data).toMatchObject({
      verifiedBy: 'u-1',
      verifiedRevisionId: 'r2',
      verificationFlag: null,
      verificationNote: null,
      expiryRemindedAt: null,
      expiredNotifiedAt: null,
    });
    const verifiedAt = call.data.verifiedAt as Date;
    expect((call.data.verificationExpiresAt as Date).getTime()).toBe(verifiedAt.getTime() + 90 * day);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.verified', subjectId: 'r2' }));
  });

  it('verify with an interval stores it; 0 means no expiry', async () => {
    const { svc, prisma } = harness(doc());
    await svc.verify('doc-1', 'u-1', { intervalDays: 0 });
    const data = (prisma.document.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ reviewIntervalDays: 0, verificationExpiresAt: null });
  });

  it('verify refuses an archived page and a page with no head, writing nothing', async () => {
    const archived = harness(doc({ archivedAt: new Date() }));
    await expect(archived.svc.verify('doc-1', 'u-1')).rejects.toBeInstanceOf(ConflictException);
    expect(archived.prisma.document.updateMany).not.toHaveBeenCalled();

    const headless = harness(doc({ branches: [{ name: 'main', headRevisionId: null }] }));
    await expect(headless.svc.verify('doc-1', 'u-1')).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'no_head_revision' }),
    });
    expect(headless.prisma.document.updateMany).not.toHaveBeenCalled();
  });

  it('flag writes one guarded statement, records the event and tells the owner but never the actor', async () => {
    const { svc, prisma, activity, notifications } = harness(doc());
    await svc.requestVerification('doc-1', { actorId: 'u-9', note: 'the SLA changed' });
    expect(prisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'doc-1', archivedAt: null },
        data: expect.objectContaining({ verificationFlag: 'requested', verificationNote: 'the SLA changed' }),
      }),
    );
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.verification-requested' }));
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['owner-1'], reason: 'owner', type: 'document.verification-requested' }),
    );

    const self = harness(doc({ ownerId: 'u-9' }));
    await self.svc.markOutdated('doc-1', { actorId: 'u-9' });
    expect(self.notifications.notify).not.toHaveBeenCalled();
    expect(self.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.outdated' }));
  });

  it('flag honours the agent guards: verified after the run, or already outdated', async () => {
    const recent = harness(doc({ verifiedAt: new Date('2026-10-11T10:00:00Z'), verifiedRevisionId: 'r2' }));
    const skipped = await recent.svc.flag('doc-1', 'requested', {
      actorId: 'u-1',
      source: { kind: 'drift', runId: 'run-1' },
      unlessVerifiedAfter: new Date('2026-10-11T09:00:00Z'),
    });
    expect(skipped).toBeNull();
    expect(recent.prisma.document.updateMany).not.toHaveBeenCalled();

    const outdated = harness(doc({ verificationFlag: 'outdated' }));
    expect(await outdated.svc.flag('doc-1', 'requested', { actorId: 'u-1', keepOutdated: true })).toBeNull();
    expect(outdated.prisma.document.updateMany).not.toHaveBeenCalled();
  });

  it('clear removes stamp and flag together and names what was there', async () => {
    const flagged = harness(doc({ verifiedRevisionId: 'r1', verificationFlag: 'requested' }));
    await flagged.svc.clear('doc-1', 'u-1');
    expect(flagged.prisma.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ verifiedRevisionId: null, verificationFlag: null }) }),
    );
    expect(flagged.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.verification-cleared' }));

    const stampedOnly = harness(doc({ verifiedRevisionId: 'r1' }));
    await stampedOnly.svc.clear('doc-1', 'u-1');
    expect(stampedOnly.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'document.unverified' }));

    const bare = harness(doc());
    await bare.svc.clear('doc-1', 'u-1');
    expect(bare.prisma.document.updateMany).not.toHaveBeenCalled();
  });

  it('archive takes the subtree scoped to the workspace, records one commit, and is idempotent', async () => {
    const { svc, prisma, commits } = harness(doc());
    prisma.document.findMany.mockResolvedValueOnce([{ id: 'doc-1' }, { id: 'doc-2' }, { id: 'doc-3' }] as never);
    const res = await svc.archive('doc-1', 'u-1');
    expect(res.affected).toBe(3);
    const findWhere = (m: typeof prisma.document.findMany) => (m.mock.calls[0]![0] as unknown as { where: Record<string, unknown> }).where;
    expect(findWhere(prisma.document.findMany)).toMatchObject({
      workspaceId: WS,
      archivedAt: null,
      OR: [{ id: 'doc-1' }, { path: { startsWith: '/doc-0/doc-1/' } }],
    });
    expect(prisma.document.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['doc-1', 'doc-2', 'doc-3'] } } }));
    expect(commits.lock).toHaveBeenCalledTimes(1);
    expect(commits.recordState).toHaveBeenCalledWith(expect.any(String), ['doc-1', 'doc-2', 'doc-3'], expect.objectContaining({ actorId: 'u-1' }));

    const alone = harness(doc());
    await alone.svc.archive('doc-1', 'u-1', false);
    expect(findWhere(alone.prisma.document.findMany)).toEqual({ workspaceId: WS, id: 'doc-1', archivedAt: null });

    // A rollback-sentinel path cannot locate a subtree: the page alone.
    const pending = harness(doc({ path: '/pending/' }));
    await pending.svc.archive('doc-1', 'u-1');
    expect(findWhere(pending.prisma.document.findMany)).not.toHaveProperty('OR');

    const already = harness(doc({ archivedAt: new Date('2026-10-01T00:00:00Z') }));
    expect(await already.svc.archive('doc-1', 'u-1')).toMatchObject({ affected: 0, archivedAt: '2026-10-01T00:00:00.000Z' });
    expect(already.prisma.document.updateMany).not.toHaveBeenCalled();
    expect(already.commits.recordState).not.toHaveBeenCalled();
  });
});

describe('KnowledgeHealthService.bulk', () => {
  function health(owned: string[]) {
    const prisma = { document: { findMany: vi.fn(async () => owned.map((id) => ({ id }))) } };
    const verification = {
      verify: vi.fn(async (id: string) => {
        if (id === 'doc-archived') {
          throw new ConflictException({ statusCode: 409, message: 'archived', reason: 'document_archived' });
        }
        return {};
      }),
      requestVerification: vi.fn(async () => ({})),
      markOutdated: vi.fn(async () => ({})),
      clear: vi.fn(async () => ({})),
      archive: vi.fn(async () => ({})),
      unarchive: vi.fn(async () => ({})),
    };
    const documents = { setOwner: vi.fn(async () => ({})), breadcrumbsFor: vi.fn(async () => new Map()) };
    const policy = { effective: vi.fn(async () => settings), override: vi.fn(async () => ({})), defaults: () => settings };
    // Page levels are pinned in permissions.spec.ts; here every page is editable except `doc-shut`.
    const permissions = {
      requireLevel: vi.fn(async (_scope: unknown, resource: { id: string }) => {
        if (resource.id === 'doc-shut') throw new ForbiddenException('editRequired');
        return 'edit';
      }),
    };
    const svc = new KnowledgeHealthService(
      prisma as never,
      policy as never,
      verification as never,
      documents as never,
      permissions as never,
      { get: () => 90 } as never,
    );
    return { svc, verification, documents };
  }

  it('refuses the whole batch when one id is foreign, before any write', async () => {
    const { svc, verification } = health(['doc-a']);
    await expect(
      svc.bulk(SCOPE, { documentIds: ['doc-a', 'doc-foreign'], action: 'verify' }, 'u-1'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ statusCode: 403, foreign: ['doc-foreign'] }) });
    expect(verification.verify).not.toHaveBeenCalled();
  });

  it('reports per id, filing a refused page by its reason rather than failing the batch', async () => {
    const { svc } = health(['doc-a', 'doc-archived']);
    const res = await svc.bulk(SCOPE, { documentIds: ['doc-a', 'doc-archived', 'doc-a'], action: 'verify', intervalDays: 30 }, 'u-1');
    expect(res.results).toEqual([
      { documentId: 'doc-a', ok: true },
      { documentId: 'doc-archived', ok: false, error: 'archived' },
    ]);
  });

  it('files a page the caller may not edit as forbidden, and touches it not (#76)', async () => {
    const { svc, verification } = health(['doc-a', 'doc-shut']);
    const res = await svc.bulk(SCOPE, { documentIds: ['doc-a', 'doc-shut'], action: 'verify' }, 'u-1');
    expect(res.results).toEqual([
      { documentId: 'doc-a', ok: true },
      { documentId: 'doc-shut', ok: false, error: 'forbidden' },
    ]);
    expect(verification.verify).toHaveBeenCalledTimes(1);
  });

  it('routes reassign through DocumentsService.setOwner so membership is checked in one place', async () => {
    const { svc, documents } = health(['doc-a']);
    await svc.bulk(SCOPE, { documentIds: ['doc-a'], action: 'reassign', ownerId: 'u-2' }, 'u-1');
    expect(documents.setOwner).toHaveBeenCalledWith('doc-a', 'u-2', 'u-1');
  });
});
