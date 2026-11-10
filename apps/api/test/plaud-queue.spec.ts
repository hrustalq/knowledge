import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { Principal } from '../src/auth/principal.js';
import { PlaudImportSweeper } from '../src/plaud/plaud-import.sweeper.js';
import { PlaudImportsService } from '../src/plaud/plaud-imports.service.js';
import { effectiveRules, listFrom, picks } from '../src/plaud/plaud-rules.js';

/**
 * Plaud auto-import (#864): which recordings the rules pick, that nothing is
 * imported before Plaud has transcribed it or before the person said yes
 * (unless they chose `auto`), that a skip is final, and that the day's cap
 * holds under a backlog. Postgres is an in-memory stand-in.
 */
const WS = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-10T12:00:00Z');
const me = { userId: 'u1', isAdmin: false } as Principal;
const rec = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Sync ${id}`, startAt: '2026-11-09T10:00:00', durationSeconds: 600, serial: 'SN1', ...over });

describe('pick rules', () => {
  const saved = new Date('2026-11-01T09:00:00Z');
  it('default to no backlog, two minutes, and asking', () => {
    expect(effectiveRules({}, saved)).toMatchObject({ since: '2026-11-01', minSeconds: 120, confirm: 'ask' });
    const rules = effectiveRules({}, saved);
    expect(picks(rules, rec('a'))).toBe(true);
    expect(picks(rules, rec('old', { startAt: '2026-10-31T23:59:00' }))).toBe(false);
    expect(picks(rules, rec('short', { durationSeconds: 119 }))).toBe(false);
  });

  it('filter by name and device, ignoring case and blank rules', () => {
    const rules = effectiveRules({ nameIncludes: ' SYNC ', nameExcludes: 'private', serial: 'SN1', minSeconds: 0 }, saved);
    expect(picks(rules, rec('a'))).toBe(true);
    expect(picks(rules, rec('b', { name: 'Private sync' }))).toBe(false);
    expect(picks(rules, rec('c', { name: 'Standup' }))).toBe(false);
    expect(picks(rules, rec('d', { serial: 'SN2' }))).toBe(false);
    expect(picks(effectiveRules({ nameIncludes: '  ', nameExcludes: '' }, saved), rec('e', { name: 'x' }))).toBe(true);
  });

  it('never lists further back than the lookback', () => {
    expect(listFrom(effectiveRules({ since: '2026-11-05' }, saved), NOW)).toBe('2026-11-05');
    expect(listFrom(effectiveRules({ since: '2026-01-01' }, saved), NOW)).toBe('2026-10-27');
  });
});

type Row = Record<string, unknown> & { id: string; status: string; externalId: string; updatedAt: Date };

function setup(over: { rules?: object; projectId?: string | null; maxPerDay?: number } = {}) {
  const link = { id: 'l1', workspaceId: WS, userId: 'u1', projectId: 'projectId' in over ? over.projectId : 'p1', rules: { since: '2026-11-01', ...over.rules }, locale: 'en', createdAt: new Date('2026-11-01T00:00:00Z'), checkedAt: null as Date | null, reconnectNotifiedAt: null as Date | null };
  const rows: Row[] = [];
  const match = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'updatedAt') return r.updatedAt >= (v as { gte: Date }).gte;
      if (v && typeof v === 'object' && 'in' in (v as object)) return (v as { in: unknown[] }).in.includes(r[k]);
      return r[k] === v;
    });
  const plaudImport = {
    createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
      for (const d of data) if (!rows.some((r) => r.externalId === d.externalId)) rows.push({ id: `i-${d.externalId}`, status: 'waiting', memoId: null, error: null, createdAt: NOW, updatedAt: new Date(NOW.getTime() - 1000 + rows.length), ...d } as Row);
    }),
    findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      rows.filter((r) => match(r, where)).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()).slice(0, take ?? 999).map((r) => ({ ...r, link }))),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: object }) => Object.assign(rows.find((r) => r.id === where.id)!, data)),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: object }) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => match(r, where)).length),
  };
  const prisma = { plaudImport, plaudLink: { deleteMany: vi.fn() } };
  const transcribed = new Set<string>();
  const plaud = {
    list: vi.fn(async (): Promise<unknown[] | null> => []),
    transcribed: vi.fn(async (_user: string, id: string): Promise<boolean | null> => transcribed.has(id)),
  };
  const memos = {
    importPlaud: vi.fn(async (_p: Principal, input: { fileId: string }) => {
      if (!transcribed.has(input.fileId)) throw new ConflictException({ statusCode: 409, message: 'not yet', reason: 'plaud-not-transcribed' });
      return { memoId: `memo-${input.fileId}` };
    }),
  };
  const service = new PlaudImportsService(prisma as never, plaud as never, memos as never, { get: () => over.maxPerDay ?? 10 } as never);
  const sweep = () => service.sweepLink(me, link as never, NOW);
  return { service, sweep, rows, plaud, memos, transcribed, link };
}
const statuses = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.externalId, r.status]));

describe('PlaudImportsService.sweepLink', () => {
  it('asks by default: a picked recording waits for Plaud, then for the person, and is never imported on its own', async () => {
    const { sweep, rows, plaud, memos, transcribed } = setup();
    plaud.list.mockResolvedValue([rec('a'), rec('short', { durationSeconds: 30 })]);
    expect(await sweep()).toEqual({ pending: 0, linked: true });
    expect(statuses(rows)).toEqual({ a: 'waiting' });
    expect(plaud.list).toHaveBeenCalledWith('u1', '2026-11-01');

    transcribed.add('a');
    expect(await sweep()).toEqual({ pending: 1, linked: true });
    expect(statuses(rows)).toEqual({ a: 'pending' });
    // A later pass does not announce it again.
    expect(await sweep()).toEqual({ pending: 0, linked: true });
    expect(memos.importPlaud).not.toHaveBeenCalled();
  });

  it('imports on a yes — now when transcribed, later when not — and stores nothing of the recording but its listing', async () => {
    const { service, sweep, rows, plaud, memos, transcribed } = setup();
    plaud.list.mockResolvedValue([rec('a'), rec('b')]);
    await sweep();
    transcribed.add('a');
    const [a, b] = await service.confirm(me, WS, ['i-a', 'i-b', 'someone-elses']);
    expect(a).toMatchObject({ status: 'imported', memoId: 'memo-a' });
    expect(b).toMatchObject({ status: 'confirmed', memoId: null, error: null });
    expect(memos.importPlaud).toHaveBeenCalledWith(me, { workspaceId: WS, projectId: 'p1', fileId: 'a' });

    transcribed.add('b');
    await sweep();
    expect(statuses(rows)).toEqual({ a: 'imported', b: 'imported' });
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'durationSeconds', 'error', 'externalId', 'id', 'linkId', 'memoId', 'name', 'startAt', 'status', 'updatedAt', 'userId', 'workspaceId']);
  });

  it('never offers a skipped recording again', async () => {
    const { service, sweep, rows, plaud, transcribed } = setup({ rules: { confirm: 'auto' } });
    plaud.list.mockResolvedValue([rec('a')]);
    await sweep();
    await service.skip('u1', WS, ['i-a']);
    transcribed.add('a');
    await sweep();
    expect(statuses(rows)).toEqual({ a: 'skipped' });
    // Nor does a yes revive it.
    expect(await service.confirm(me, WS, ['i-a'])).toEqual([]);
  });

  it('in auto mode imports what Plaud has transcribed, up to the day’s cap, and a confirmed one past it', async () => {
    const { service, sweep, rows, plaud, transcribed, memos } = setup({ rules: { confirm: 'auto' }, maxPerDay: 2 });
    plaud.list.mockResolvedValue(['a', 'b', 'c', 'd'].map((id) => rec(id)));
    ['a', 'b', 'c'].forEach((id) => transcribed.add(id));
    expect(await sweep()).toEqual({ pending: 0, linked: true });
    expect(statuses(rows)).toEqual({ a: 'imported', b: 'imported', c: 'waiting', d: 'waiting' });
    await sweep();
    expect(memos.importPlaud).toHaveBeenCalledTimes(2);

    await service.confirm(me, WS, ['i-c']);
    expect(statuses(rows).c).toBe('imported');
  });

  it('records a refused import on the row and lets it be confirmed again', async () => {
    const { service, sweep, rows, plaud, transcribed, memos } = setup();
    plaud.list.mockResolvedValue([rec('a')]);
    await sweep();
    transcribed.add('a');
    memos.importPlaud.mockRejectedValueOnce(new ConflictException('Over the model budget')).mockRejectedValueOnce(new Error('ECONNRESET 10.0.0.5'));
    expect((await service.confirm(me, WS, ['i-a']))[0]).toMatchObject({ status: 'failed', error: 'Over the model budget' });
    // Anything that is not ours to show is not shown.
    expect((await service.confirm(me, WS, ['i-a']))[0].error).not.toContain('10.0.0.5');
    expect((await service.confirm(me, WS, ['i-a']))[0]).toMatchObject({ status: 'imported' });
    expect(rows).toHaveLength(1);
  });

  it('does nothing with auto-import off, and stops when the sign-in is gone', async () => {
    const off = setup({ projectId: null });
    expect(await off.sweep()).toEqual({ pending: 0, linked: true });
    expect(off.plaud.list).not.toHaveBeenCalled();

    const gone = setup();
    gone.plaud.list.mockResolvedValue(null);
    expect(await gone.sweep()).toEqual({ pending: 0, linked: false });
  });
});

describe('PlaudImportSweeper', () => {
  function setup(over: { token?: string | null; role?: boolean; deleted?: boolean; projectId?: string | null; pending?: number; linked?: boolean } = {}) {
    const link = { id: 'l1', workspaceId: WS, userId: 'u1', projectId: 'projectId' in over ? over.projectId : 'p1', locale: 'en', checkedAt: null as Date | null, reconnectNotifiedAt: null as Date | null };
    const prisma = {
      plaudLink: {
        findMany: vi.fn(async ({ where }: { where: { OR: [unknown, { checkedAt: { lt: Date } }] } }) => (link.checkedAt && link.checkedAt >= where.OR[1].checkedAt.lt ? [] : [{ ...link }])),
        updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<typeof link> }) => {
          if ('reconnectNotifiedAt' in where && link.reconnectNotifiedAt !== null) return { count: 0 };
          Object.assign(link, data);
          return { count: 1 };
        }),
        update: vi.fn(async ({ data }: { data: Partial<typeof link> }) => Object.assign(link, data)),
      },
      workspace: { findFirst: vi.fn(async () => (over.deleted ? null : { id: WS })) },
    };
    const oauth = { configured: true, tokenFor: vi.fn(async () => ('token' in over ? over.token : 'tok')), status: vi.fn(async () => ({ linked: true })) };
    const imports = { sweepLink: vi.fn(async () => ({ pending: over.pending ?? 0, linked: over.linked ?? true })) };
    const access = { principalFor: vi.fn(async () => me), requireRole: vi.fn(async () => { if (over.role === false) throw new Error('forbidden'); }) };
    const notifications = { notify: vi.fn(async () => []) };
    const sweeper = new PlaudImportSweeper(prisma as never, oauth as never, imports as never, access as never, notifications as never, { announce: vi.fn() } as never);
    return { sweeper, link, oauth, imports, access, notifications };
  }

  it('claims a due account once, checks the role now, and announces a count without a name', async () => {
    const { sweeper, imports, access, notifications, link } = setup({ pending: 3 });
    await sweeper.sweep(NOW);
    await sweeper.sweep(NOW);
    expect(imports.sweepLink).toHaveBeenCalledTimes(1);
    expect(access.requireRole).toHaveBeenCalledWith(me, WS, 'editor');
    expect(link.checkedAt).toEqual(NOW);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'plaud.pending', userIds: ['u1'], title: 'Plaud', metadata: { pending: 3 } }));
  });

  it('imports nothing for a person who is no longer an editor, or in a workspace being deleted', async () => {
    const demoted = setup({ role: false });
    await demoted.sweeper.sweep(NOW);
    expect(demoted.imports.sweepLink).not.toHaveBeenCalled();
    const deleted = setup({ deleted: true });
    await deleted.sweeper.sweep(NOW);
    expect(deleted.oauth.tokenFor).not.toHaveBeenCalled();
  });

  it('keeps a paused account’s sign-in alive without reading its recordings', async () => {
    const { sweeper, oauth, imports } = setup({ projectId: null });
    await sweeper.sweep(NOW);
    expect(oauth.tokenFor).toHaveBeenCalledWith('u1');
    expect(imports.sweepLink).not.toHaveBeenCalled();
  });

  it('says once that the sign-in lapsed, and clears the mark when it is back', async () => {
    const { sweeper, notifications, link, oauth } = setup({ token: null });
    await sweeper.sweep(NOW);
    await sweeper.sweep(new Date(NOW.getTime() + 3_600_000));
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'plaud.reconnect' }));
    oauth.tokenFor.mockResolvedValue('tok');
    await sweeper.sweep(new Date(NOW.getTime() + 7_200_000));
    expect(link.reconnectNotifiedAt).toBeNull();
  });
});
