import { describe, expect, it } from 'vitest';
import { isScheduleDue, nextScheduledRun, type AgentScheduleSpec } from '@knowledge/contracts';
import { nextRunOf } from '../src/agents/agent-schedule.js';

/**
 * Time-of-day agent schedules (#70): the one predicate the sweeper, the agent
 * summary's `nextRunAt` and the editor all read. Instants are written in UTC;
 * Europe/Moscow is UTC+3 all year, America/New_York changes on 2026-03-08 and
 * 2026-11-01.
 */
const at = (iso: string) => new Date(iso);
const spec = (over: Partial<AgentScheduleSpec>): AgentScheduleSpec => ({
  kind: null,
  minutes: null,
  time: null,
  weekdays: null,
  timezone: null,
  ...over,
});

describe('interval schedules (the pre-#70 rule, unchanged)', () => {
  const every = spec({ minutes: 60 });

  it('never run means due now', () => {
    const now = at('2026-10-15T10:00:00Z');
    expect(nextScheduledRun(every, { lastRunAt: null, changedAt: null }, now)).toEqual(now);
    expect(isScheduleDue(every, { lastRunAt: null, changedAt: null }, now)).toBe(true);
  });

  it('is due exactly when lastRunAt + minutes has passed, as the old inline check was', () => {
    const lastRunAt = at('2026-10-15T09:00:00Z');
    for (const minute of [0, 30, 59, 60, 61, 120]) {
      const now = new Date(lastRunAt.getTime() + minute * 60_000);
      const old = lastRunAt.getTime() + 60 * 60_000 <= now.getTime();
      expect(isScheduleDue(every, { lastRunAt, changedAt: null }, now)).toBe(old);
    }
  });

  it('ignores changedAt, so an edit does not postpone an interval', () => {
    const state = { lastRunAt: at('2026-10-15T08:00:00Z'), changedAt: at('2026-10-15T09:30:00Z') };
    expect(isScheduleDue(every, state, at('2026-10-15T09:31:00Z'))).toBe(true);
  });

  it('an interval with no minutes never fires', () => {
    expect(nextScheduledRun(spec({}), { lastRunAt: null, changedAt: null }, at('2026-10-15T10:00:00Z'))).toBeNull();
  });
});

describe('daily schedules', () => {
  const daily = spec({ kind: 'daily', time: '09:00', timezone: 'Europe/Moscow' });

  it('fires on the first tick after the slot, once', () => {
    const lastRunAt = at('2026-10-14T06:02:00Z'); // yesterday 09:02 MSK
    const state = { lastRunAt, changedAt: null };
    expect(nextScheduledRun(daily, state, at('2026-10-15T05:58:00Z'))).toEqual(at('2026-10-15T06:00:00Z'));
    expect(isScheduleDue(daily, state, at('2026-10-15T05:58:00Z'))).toBe(false);
    expect(isScheduleDue(daily, state, at('2026-10-15T06:03:00Z'))).toBe(true);

    // The sweeper stamps lastRunAt when it starts the run; the next tick is quiet.
    const after = { lastRunAt: at('2026-10-15T06:03:00Z'), changedAt: null };
    expect(isScheduleDue(daily, after, at('2026-10-15T06:08:00Z'))).toBe(false);
    expect(nextScheduledRun(daily, after, at('2026-10-15T06:08:00Z'))).toEqual(at('2026-10-16T06:00:00Z'));
  });

  it('a worker down across several slots fires once, not once per slot', () => {
    const state = { lastRunAt: at('2026-10-11T06:01:00Z'), changedAt: null };
    const now = at('2026-10-15T12:00:00Z');
    expect(isScheduleDue(daily, state, now)).toBe(true);
    const ran = { lastRunAt: now, changedAt: null };
    expect(isScheduleDue(daily, ran, at('2026-10-15T12:05:00Z'))).toBe(false);
    expect(nextScheduledRun(daily, ran, now)).toEqual(at('2026-10-16T06:00:00Z'));
  });

  it('an edit restarts the count, so a slot moved into the past does not fire', () => {
    // Moved to 08:00 at 10:00 MSK; last ran yesterday.
    const moved = spec({ kind: 'daily', time: '08:00', timezone: 'Europe/Moscow' });
    const state = { lastRunAt: at('2026-10-14T06:00:00Z'), changedAt: at('2026-10-15T07:00:00Z') };
    expect(isScheduleDue(moved, state, at('2026-10-15T07:05:00Z'))).toBe(false);
    expect(nextScheduledRun(moved, state, at('2026-10-15T07:05:00Z'))).toEqual(at('2026-10-16T05:00:00Z'));
  });

  it('never run and never stamped: the most recent slot is owed', () => {
    const now = at('2026-10-15T07:00:00Z'); // 10:00 MSK
    expect(nextScheduledRun(daily, { lastRunAt: null, changedAt: null }, now)).toEqual(at('2026-10-15T06:00:00Z'));
  });

  it('enabled today before the slot runs today; after the slot, tomorrow', () => {
    const before = { lastRunAt: null, changedAt: at('2026-10-15T05:00:00Z') };
    expect(nextScheduledRun(daily, before, at('2026-10-15T05:00:00Z'))).toEqual(at('2026-10-15T06:00:00Z'));
    const after = { lastRunAt: null, changedAt: at('2026-10-15T07:00:00Z') };
    expect(nextScheduledRun(daily, after, at('2026-10-15T07:00:00Z'))).toEqual(at('2026-10-16T06:00:00Z'));
  });

  it('a null or unknown timezone reads as UTC', () => {
    const state = { lastRunAt: at('2026-10-14T09:30:00Z'), changedAt: null };
    for (const timezone of [null, 'Mars/Olympus_Mons']) {
      expect(nextScheduledRun({ ...daily, timezone }, state, at('2026-10-15T00:00:00Z'))).toEqual(
        at('2026-10-15T09:00:00Z'),
      );
    }
  });

  it('a time-of-day schedule without a time never fires', () => {
    expect(nextScheduledRun({ ...daily, time: null }, { lastRunAt: null, changedAt: null }, new Date())).toBeNull();
    expect(nextScheduledRun({ ...daily, time: '24:00' }, { lastRunAt: null, changedAt: null }, new Date())).toBeNull();
  });
});

describe('weekly schedules', () => {
  // 2026-10-12 is a Monday.
  const monday = spec({ kind: 'weekly', time: '09:00', weekdays: [1], timezone: 'Europe/Moscow' });

  it('Mon 09:00 Europe/Moscow fires once a week', () => {
    const state = { lastRunAt: at('2026-10-12T06:01:00Z'), changedAt: null };
    expect(isScheduleDue(monday, state, at('2026-10-13T08:00:00Z'))).toBe(false);
    expect(nextScheduledRun(monday, state, at('2026-10-13T08:00:00Z'))).toEqual(at('2026-10-19T06:00:00Z'));
    expect(isScheduleDue(monday, state, at('2026-10-19T06:04:00Z'))).toBe(true);
  });

  it('a weekday mask skips the weekend', () => {
    const weekdays = { ...monday, weekdays: [1, 2, 3, 4, 5] };
    const friday = { lastRunAt: at('2026-10-16T06:01:00Z'), changedAt: null };
    expect(nextScheduledRun(weekdays, friday, at('2026-10-17T12:00:00Z'))).toEqual(at('2026-10-19T06:00:00Z'));
  });

  it('a week-long outage fires once', () => {
    const state = { lastRunAt: at('2026-09-28T06:01:00Z'), changedAt: null };
    const now = at('2026-10-15T12:00:00Z');
    expect(isScheduleDue(monday, state, now)).toBe(true);
    expect(isScheduleDue(monday, { lastRunAt: now, changedAt: null }, at('2026-10-15T12:05:00Z'))).toBe(false);
  });

  it('the local weekday decides, not the UTC one', () => {
    // Monday 01:00 in Moscow is Sunday 22:00 UTC.
    const early = { ...monday, time: '01:00' };
    const state = { lastRunAt: at('2026-10-12T00:00:00Z'), changedAt: null };
    expect(nextScheduledRun(early, state, at('2026-10-14T00:00:00Z'))).toEqual(at('2026-10-18T22:00:00Z'));
  });

  it('no weekdays never fires', () => {
    expect(nextScheduledRun({ ...monday, weekdays: [] }, { lastRunAt: null, changedAt: null }, new Date())).toBeNull();
  });
});

describe('daylight saving', () => {
  const ny = (time: string) => spec({ kind: 'daily', time, timezone: 'America/New_York' });

  it('keeps the wall-clock time across the fall-back change', () => {
    const state = { lastRunAt: at('2026-10-31T13:00:00Z'), changedAt: null }; // 09:00 EDT
    expect(nextScheduledRun(ny('09:00'), state, at('2026-10-31T14:00:00Z'))).toEqual(at('2026-11-01T14:00:00Z'));
  });

  it('keeps the wall-clock time across the spring-forward change', () => {
    const state = { lastRunAt: at('2026-03-07T14:00:00Z'), changedAt: null }; // 09:00 EST
    expect(nextScheduledRun(ny('09:00'), state, at('2026-03-07T15:00:00Z'))).toEqual(at('2026-03-08T13:00:00Z'));
  });

  it('a slot in the skipped hour fires once that day, an hour later', () => {
    const state = { lastRunAt: at('2026-03-07T07:30:00Z'), changedAt: null }; // 02:30 EST
    const next = nextScheduledRun(ny('02:30'), state, at('2026-03-07T08:00:00Z'));
    expect(next).toEqual(at('2026-03-08T07:30:00Z')); // 03:30 EDT
    expect(nextScheduledRun(ny('02:30'), { lastRunAt: next, changedAt: null }, next!)).toEqual(
      at('2026-03-09T06:30:00Z'),
    );
  });

  it('a slot in the repeated hour fires once', () => {
    const first = { lastRunAt: at('2026-11-01T05:32:00Z'), changedAt: null }; // after 01:30 EDT
    expect(nextScheduledRun(ny('01:30'), first, at('2026-11-01T06:40:00Z'))).toEqual(at('2026-11-02T06:30:00Z'));
  });
});

describe('nextRunOf (the row side)', () => {
  const row = {
    scheduleEnabled: true,
    scheduleKind: null,
    scheduleMinutes: 30,
    scheduleTime: null,
    scheduleWeekdays: null,
    scheduleTimezone: null,
    lastRunAt: at('2026-10-15T09:00:00Z'),
    scheduleChangedAt: null,
  };

  it('a row with only scheduleMinutes is an interval schedule, exactly as before', () => {
    expect(nextRunOf(row, at('2026-10-15T09:10:00Z'))).toEqual(at('2026-10-15T09:30:00Z'));
  });

  it('a disabled schedule has no next run', () => {
    expect(nextRunOf({ ...row, scheduleEnabled: false })).toBeNull();
  });

  it('stored weekdays outside 0–6 are dropped, and an unknown kind reads as interval', () => {
    expect(
      nextRunOf(
        { ...row, scheduleKind: 'weekly', scheduleTime: '09:00', scheduleWeekdays: [1, 9, 'x'] },
        at('2026-10-15T09:10:00Z'),
      ),
    ).toEqual(at('2026-10-19T09:00:00Z'));
    expect(nextRunOf({ ...row, scheduleKind: 'hourly' }, at('2026-10-15T09:10:00Z'))).toEqual(
      at('2026-10-15T09:30:00Z'),
    );
  });
});

describe('AgentScheduleSweeper.startDue', async () => {
  const { AgentScheduleSweeper } = await import('../src/agents/agent-schedule.sweeper.js');
  const { vi } = await import('vitest');

  const agent = (over: Record<string, unknown>) => ({
    id: `agent-${String(over.key)}`,
    workspaceId: 'ws',
    key: 'reviewer',
    enabled: true,
    scheduleEnabled: true,
    scheduleKind: null,
    scheduleMinutes: null,
    scheduleTime: null,
    scheduleWeekdays: null,
    scheduleTimezone: null,
    scheduleChangedAt: null,
    scheduleNote: null,
    scheduleOwner: '00000000-0000-4000-8000-000000000001',
    lastRunAt: null,
    ...over,
  });

  function sweeperWith(candidates: ReturnType<typeof agent>[]) {
    const created: Record<string, unknown>[] = [];
    const findMany = vi.fn(async () => candidates);
    const prisma = {
      aiAgent: { findMany, update: vi.fn(async () => ({})) },
      agentRun: {
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `run-${created.length}`, ...data };
        }),
      },
      user: { findUnique: vi.fn(async () => ({ locale: 'ru' })) },
    };
    const producer = { enqueue: vi.fn(async () => undefined) };
    const sweeper = new AgentScheduleSweeper(prisma as never, producer as never, { get: () => true } as never);
    const startDue = () => (sweeper as unknown as { startDue(): Promise<void> }).startDue();
    return { startDue, created, findMany, producer };
  }

  it('starts a due daily schedule and leaves a not-yet-due one alone', async () => {
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    const anHourAgo = new Date(now.getTime() - 60 * 60_000);
    const inAnHour = new Date(now.getTime() + 60 * 60_000);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60_000 - 2 * 60 * 60_000);
    const { startDue, created } = sweeperWith([
      agent({ key: 'reviewer', scheduleKind: 'daily', scheduleTime: hhmm(anHourAgo), lastRunAt: yesterday }),
      agent({ key: 'curator', scheduleKind: 'daily', scheduleTime: hhmm(inAnHour), lastRunAt: new Date(now.getTime() - 60_000) }),
    ]);
    await startDue();
    expect(created.map((run) => run.agentKey)).toEqual(['reviewer']);
    expect(created[0]).toMatchObject({ trigger: 'schedule', locale: 'ru' });
  });

  it('asks for interval and time-of-day candidates alike', async () => {
    const { startDue, findMany } = sweeperWith([]);
    await startDue();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ scheduleMinutes: { not: null } }, { scheduleTime: { not: null } }],
        }),
      }),
    );
  });

  it('an interval-only row fires on the old rule', async () => {
    const { startDue, created } = sweeperWith([
      agent({ key: 'reviewer', scheduleMinutes: 60, lastRunAt: new Date(Date.now() - 61 * 60_000) }),
      agent({ key: 'curator', scheduleMinutes: 60, lastRunAt: new Date(Date.now() - 59 * 60_000) }),
    ]);
    await startDue();
    expect(created.map((run) => run.agentKey)).toEqual(['reviewer']);
  });
});

describe('AiAgentsService.update — schedule validation', async () => {
  const { AiAgentsService } = await import('../src/ai/ai-agents.service.js');
  const { vi } = await import('vitest');
  const OWNER = '00000000-0000-4000-8000-000000000001';

  function serviceWith(existing: Record<string, unknown> | null) {
    const writes: Record<string, unknown>[] = [];
    let row = existing;
    const prisma = {
      aiAgent: {
        findUnique: vi.fn(async () => row),
        upsert: vi.fn(async ({ update, create }: { update: Record<string, unknown>; create: Record<string, unknown> }) => {
          writes.push(row ? update : create);
          row = { ...(row ?? create), ...update, updatedAt: new Date() };
          return row;
        }),
      },
    };
    const registry = {
      resolve: vi.fn(async () => ({
        key: 'reviewer',
        builtIn: true,
        name: 'Reviewer',
        description: '',
        instructions: '',
        tools: [],
        skillIds: [],
        purpose: 'review',
        surfaces: ['background'],
        requires: [],
        enabled: true,
        config: { providerId: null, providerName: null, temperature: null, maxToolCalls: 8, timeoutMs: 60_000 },
        missing: [],
      })),
      invalidate: vi.fn(),
    };
    return { service: new AiAgentsService(prisma as never, registry as never, {} as never), writes };
  }

  const ws = '11111111-1111-4111-8111-111111111111';

  it('a weekly schedule needs a time and weekdays', async () => {
    const { service } = serviceWith(null);
    await expect(
      service.update(ws, 'reviewer', { workspaceId: ws, scheduleEnabled: true, scheduleKind: 'weekly' }, OWNER),
    ).rejects.toThrow('agentScheduleNeedsTime');
    await expect(
      service.update(
        ws,
        'reviewer',
        { workspaceId: ws, scheduleEnabled: true, scheduleKind: 'weekly', scheduleTime: '09:00' },
        OWNER,
      ),
    ).rejects.toThrow('agentScheduleNeedsWeekdays');
  });

  it('an unknown timezone is refused', async () => {
    const { service } = serviceWith(null);
    await expect(
      service.update(ws, 'reviewer', { workspaceId: ws, scheduleTimezone: 'Mars/Olympus_Mons' }, OWNER),
    ).rejects.toThrow('agentScheduleBadTimezone');
  });

  it('switching an enabled interval to weekly without weekdays is refused, not saved silent', async () => {
    const { service } = serviceWith({ scheduleEnabled: true, scheduleMinutes: 60, scheduleOwner: OWNER });
    await expect(
      service.update(ws, 'reviewer', { workspaceId: ws, scheduleKind: 'weekly', scheduleTime: '09:00' }, OWNER),
    ).rejects.toThrow('agentScheduleNeedsWeekdays');
  });

  it('saves a valid weekly schedule, deduped and sorted, and stamps scheduleChangedAt', async () => {
    const { service, writes } = serviceWith(null);
    const summary = await service.update(
      ws,
      'reviewer',
      {
        workspaceId: ws,
        scheduleEnabled: true,
        scheduleKind: 'weekly',
        scheduleTime: '09:00',
        scheduleWeekdays: [5, 1, 1],
        scheduleTimezone: 'Europe/Moscow',
      },
      OWNER,
    );
    expect(writes[0]).toMatchObject({ scheduleWeekdays: [1, 5], scheduleOwner: OWNER });
    expect(writes[0].scheduleChangedAt).toBeInstanceOf(Date);
    expect(summary).toMatchObject({ scheduleKind: 'weekly', scheduleWeekdays: [1, 5], scheduleTimezone: 'Europe/Moscow' });
    expect(summary.nextRunAt).not.toBeNull();
  });

  it('an edit that does not touch the schedule leaves scheduleChangedAt alone', async () => {
    const { service, writes } = serviceWith({ scheduleEnabled: true, scheduleMinutes: 60, scheduleOwner: OWNER });
    await service.update(ws, 'reviewer', { workspaceId: ws, scheduleNote: 'focus on onboarding' }, OWNER);
    expect(writes[0]).not.toHaveProperty('scheduleChangedAt');
  });
});

describe('page-scoped runs (AgentRunInput.documentIds)', async () => {
  const { AgentRunsService } = await import('../src/ai/ai-agents.service.js');
  const { vi } = await import('vitest');
  const ws = '11111111-1111-4111-8111-111111111111';
  const page = '22222222-2222-4222-8222-222222222222';

  function serviceFor(key: string) {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      agentRun: {
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: 'run', status: 'pending', createdAt: new Date(), updatedAt: new Date(), ...data };
        }),
      },
      aiAgent: { findUnique: vi.fn(async () => null) },
    };
    const registry = {
      resolve: vi.fn(async () => ({ key, name: key, enabled: true, surfaces: ['background'] })),
    };
    const usage = { assertWithinBudget: vi.fn(async () => undefined) };
    const producer = { enqueue: vi.fn(async () => undefined) };
    const service = new AgentRunsService(prisma as never, registry as never, usage as never, producer as never);
    const principal = { userId: '00000000-0000-4000-8000-000000000001', locale: 'en' };
    return { service, created, principal };
  }

  it('stores the pages on a reviewer run, deduped', async () => {
    const { service, created, principal } = serviceFor('reviewer');
    await service.start(ws, 'reviewer', principal as never, { documentIds: [page, page] }).catch(() => undefined);
    expect(created[0]?.input).toEqual({ documentIds: [page] });
  });

  it('refuses pages for an agent that does not read pages', async () => {
    const { service, created, principal } = serviceFor('cartographer');
    await expect(service.start(ws, 'cartographer', principal as never, { documentIds: [page] })).rejects.toThrow(
      'agentNotPageScoped',
    );
    expect(created).toHaveLength(0);
  });

  it('a run without pages stores no input, as before', async () => {
    const { service, created, principal } = serviceFor('reviewer');
    await service.start(ws, 'reviewer', principal as never, {}).catch(() => undefined);
    expect(created[0]?.input).toBeUndefined();
  });
});
