import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_ACTOR } from '../src/activity/actor.js';
import { VerificationSweeper } from '../src/verification/verification.sweeper.js';

/**
 * The expiry sweeper (docs/features/39, issue #66 phase 3): a page owner hears
 * once that a stamp is about to run out and once that it has, the "expired"
 * feed row is the system's, and legacy `body_chars` are filled from the source.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-11T12:00:00Z');

function due(over: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    workspace_id: WS,
    project_id: 'p-1',
    title: 'Billing',
    owner_id: 'owner-1',
    verified_by: 'verifier-1',
    verification_expires_at: new Date('2026-10-15T00:00:00Z'),
    ...over,
  };
}

function harness(opts: { rows?: unknown[]; claim?: number; revisions?: unknown[]; source?: string | Error } = {}) {
  const prisma = {
    // The first two raw queries are remind + expire; the third is body_chars.
    $queryRaw: vi.fn(),
    document: { updateMany: vi.fn(async () => ({ count: opts.claim ?? 1 })) },
    documentRevision: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const activity = { record: vi.fn(async () => undefined) };
  const notifications = { notify: vi.fn(async () => []) };
  const policy = { defaults: vi.fn(() => ({ reviewIntervalDays: 90, remindBeforeDays: 7, inactiveAfterDays: 180, emptyMaxChars: 40, trustRanking: true })) };
  const storage = {
    getObjectText: vi.fn(async () => {
      if (opts.source instanceof Error) throw opts.source;
      return opts.source ?? '---\ntitle: x\n---\n\nhello world\n';
    }),
  };
  const config = { get: vi.fn(() => true) };
  const sweeper = new VerificationSweeper(
    prisma as never,
    activity as never,
    notifications as never,
    policy as never,
    storage as never,
    config as never,
  );
  return { sweeper, prisma, activity, notifications, storage };
}

describe('VerificationSweeper.remind', () => {
  it('claims the row before telling the owner, and tells nobody when another replica claimed it', async () => {
    const { sweeper, prisma, notifications } = harness({ claim: 0 });
    prisma.$queryRaw.mockResolvedValueOnce([due()]);
    expect(await sweeper.remind(NOW)).toBe(0);
    expect(prisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', expiryRemindedAt: null },
      data: { expiryRemindedAt: NOW },
    });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('tells the owner under reason owner with no actor, and records no feed row', async () => {
    const { sweeper, prisma, notifications, activity } = harness();
    prisma.$queryRaw.mockResolvedValueOnce([due()]);
    expect(await sweeper.remind(NOW)).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      userIds: ['owner-1'],
      type: 'document.verification-expiring',
      reason: 'owner',
      actor: null,
      documentId: 'doc-1',
      subjectType: 'document',
      subjectId: 'doc-1',
      title: 'Billing',
    });
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('falls back to the last verifier on an unowned page, and sends nothing when there is neither', async () => {
    const { sweeper, prisma, notifications } = harness();
    prisma.$queryRaw.mockResolvedValueOnce([due({ owner_id: null }), due({ id: 'doc-2', owner_id: null, verified_by: null })]);
    expect(await sweeper.remind(NOW)).toBe(2);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({ userIds: ['verifier-1'] });
  });

  it('resolves the reminder window from the env default in SQL, per workspace row', async () => {
    const { sweeper, prisma } = harness();
    prisma.$queryRaw.mockResolvedValueOnce([]);
    await sweeper.remind(NOW);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toContain('expiry_reminded_at IS NULL');
    expect(sql).toContain('COALESCE(s.remind_before_days');
    expect(sql).toContain('b.head_revision_id = d.verified_revision_id');
    expect(sql).toContain('verification_flag IS NULL');
    expect(values).toContain(7);
  });
});

describe('VerificationSweeper.expire', () => {
  it('claims once, writes the expired feed row as the system and tells the owner', async () => {
    const { sweeper, prisma, notifications, activity } = harness();
    prisma.$queryRaw.mockResolvedValueOnce([due()]);
    expect(await sweeper.expire(NOW)).toBe(1);
    expect(prisma.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1', expiredNotifiedAt: null },
      data: { expiredNotifiedAt: NOW },
    });
    expect(activity.record).toHaveBeenCalledTimes(1);
    expect(activity.record.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      actor: SYSTEM_ACTOR,
      action: 'document.verification-expired',
      documentId: 'doc-1',
      projectId: 'p-1',
      patch: { verification: 'expired' },
    });
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({
      type: 'document.verification-expired',
      userIds: ['owner-1'],
      reason: 'owner',
    });
  });

  it('a lost claim writes nothing and tells nobody', async () => {
    const { sweeper, prisma, notifications, activity } = harness({ claim: 0 });
    prisma.$queryRaw.mockResolvedValueOnce([due()]);
    expect(await sweeper.expire(NOW)).toBe(0);
    expect(activity.record).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

describe('VerificationSweeper.fillBodyChars', () => {
  it('measures the body without frontmatter and writes it only where still null', async () => {
    const { sweeper, prisma, storage } = harness({ source: '---\ntitle: x\n---\n\nhello world\n' });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'r-1', s3_key: 'workspaces/ws/documents/d/revisions/r-1/source.md' }]);
    expect(await sweeper.fillBodyChars()).toBe(1);
    expect(storage.getObjectText).toHaveBeenCalledWith('workspaces/ws/documents/d/revisions/r-1/source.md');
    expect(prisma.documentRevision.updateMany).toHaveBeenCalledWith({
      where: { id: 'r-1', bodyChars: null },
      data: { bodyChars: 'hello world'.length },
    });
  });

  it('skips a revision whose source cannot be read, and does not retry it on the next tick', async () => {
    const { sweeper, prisma } = harness({ source: new Error('NoSuchKey') });
    prisma.$queryRaw.mockResolvedValue([{ id: 'r-1', s3_key: 'k' }]);
    expect(await sweeper.fillBodyChars()).toBe(0);
    expect(await sweeper.fillBodyChars()).toBe(0);
    expect(prisma.documentRevision.updateMany).not.toHaveBeenCalled();
  });
});

describe('VerificationSweeper.sweep', () => {
  it('runs remind, expire and the catch-up in order, and never overlaps itself', async () => {
    const { sweeper, prisma } = harness();
    let release!: () => void;
    const gate = new Promise<unknown[]>((resolve) => {
      release = () => resolve([]);
    });
    prisma.$queryRaw.mockReturnValueOnce(gate).mockResolvedValue([]);
    const first = sweeper.sweep(NOW);
    await sweeper.sweep(NOW); // back-pressure: returns immediately
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
