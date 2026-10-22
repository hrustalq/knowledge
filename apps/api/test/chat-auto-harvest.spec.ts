import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { ChatAutoHarvestSweeper, isThreadDue, pickDue } from '../src/chat/chat-auto-harvest.sweeper.js';
import { ChatBufferService, type ListenedThread } from '../src/chat/chat-buffer.service.js';
import { ChatIntegrationsService } from '../src/chat/chat-integrations.service.js';
import { HarvestRefused } from '../src/chat/harvest.service.js';

/**
 * Automatic harvest of listening threads (#340). What is pinned: the one due
 * check (enough new messages, quiet long enough); the spend cap per binding
 * per tick; a sweep never stacks on itself; a thread is harvested once per
 * change — the mark moves before the model is called, a second process or a
 * second sweep over the same snapshot loses, and only messages after the mark
 * and the switch are read; a refusal that will pass puts the mark back; the
 * captures are the enabling admin's, re-checked as admin on every harvest; and
 * nothing is posted in the group — the admin gets an inbox row with counts.
 */

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MIN = 60_000;
const cfg = { minMessages: 5, quietMinutes: 60, maxPerTick: 1 };

function thread(over: Partial<ListenedThread> = {}): ListenedThread {
  return { bindingId: 'b-1', topicKey: '', fresh: 6, newestAt: new Date(NOW - 61 * MIN), through: null, ...over };
}

describe('the due check', () => {
  it('needs at least the minimum of new messages', () => {
    expect(isThreadDue(thread({ fresh: 4 }), NOW, cfg)).toBe(false);
    expect(isThreadDue(thread({ fresh: 5 }), NOW, cfg)).toBe(true);
  });

  it('needs the thread quiet for the whole quiet time — a conversation still going is not harvested', () => {
    expect(isThreadDue(thread({ newestAt: new Date(NOW - 59 * MIN) }), NOW, cfg)).toBe(false);
    expect(isThreadDue(thread({ newestAt: new Date(NOW - 60 * MIN) }), NOW, cfg)).toBe(true);
  });
});

describe('the spend cap', () => {
  it('takes at most maxPerTick threads per binding, the longest quiet first, and leaves the rest due', () => {
    const threads = [
      thread({ topicKey: 'a', newestAt: new Date(NOW - 90 * MIN) }),
      thread({ topicKey: 'b', newestAt: new Date(NOW - 300 * MIN) }),
      thread({ topicKey: 'c', newestAt: new Date(NOW - 120 * MIN) }),
      thread({ bindingId: 'b-2', topicKey: '' }),
      thread({ bindingId: 'b-3', fresh: 1 }),
    ];
    const due = pickDue(threads, NOW, cfg);
    expect(due.map((t) => `${t.bindingId}/${t.topicKey}`)).toEqual(['b-1/b', 'b-2/']);
    expect(pickDue(threads, NOW, { ...cfg, maxPerTick: 2 }).filter((t) => t.bindingId === 'b-1').map((t) => t.topicKey)).toEqual(['b', 'c']);
    expect(pickDue(threads, NOW, { ...cfg, maxPerTick: 0 })).toEqual([]);
  });
});

// -----------------------------------------------------------------------------

const AUTO_AT = new Date(NOW - 3 * 86_400_000);

function harness(over: { threads?: ListenedThread[]; harvest?: () => Promise<unknown>; requireRole?: () => Promise<void>; claimCount?: number } = {}) {
  const binding = {
    id: 'b-1',
    workspaceId: 'ws',
    externalChatId: '-1001',
    title: 'Platform team',
    projectId: 'p-1',
    locale: null,
    listening: true,
    autoHarvestBy: 'admin-1',
    autoHarvestAt: AUTO_AT,
    integration: { id: 'int-1', kind: 'telegram', locale: 'en' },
  };
  const prisma = {
    chatChannelBinding: { findMany: vi.fn(async () => [binding]) },
    chatHarvestMark: {
      createMany: vi.fn(async () => ({ count: over.claimCount ?? 1 })),
      updateMany: vi.fn(async () => ({ count: over.claimCount ?? 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const buffer = {
    listenedThreads: vi.fn(async () => over.threads ?? [thread()]),
    listenedThread: vi.fn(async () => ({
      thread: { messages: [{ authorId: '7', text: 'We ship on Fridays', at: new Date(NOW - 70 * MIN) }], url: null, truncated: false },
      firstMessageId: '41',
    })),
  };
  const principal = { userId: 'admin-1', locale: 'en' };
  const harvester = { harvest: vi.fn(over.harvest ?? (async () => ({ proposed: 2, duplicates: 1, dropped: 3 }))) };
  const access = { principalFor: vi.fn(async () => principal), requireRole: vi.fn(over.requireRole ?? (async () => undefined)) };
  const adapter = { messageUrl: vi.fn(() => 'https://t.me/c/1/41'), postMessage: vi.fn() };
  const notifications = { notify: vi.fn(async () => [{ userId: 'admin-1' }]) };
  const events = { announce: vi.fn(async () => undefined) };
  const env: Record<string, unknown> = {
    CHAT_ENABLED: true,
    HARVEST_ENABLED: true,
    HARVEST_AUTO_ENABLED: true,
    HARVEST_AUTO_MIN_MESSAGES: cfg.minMessages,
    HARVEST_AUTO_QUIET_MINUTES: cfg.quietMinutes,
    HARVEST_AUTO_MAX_PER_TICK: cfg.maxPerTick,
    HARVEST_MAX_MESSAGES: 200,
  };
  const sweeper = new ChatAutoHarvestSweeper(
    prisma as never,
    buffer as never,
    harvester as never,
    access as never,
    { get: () => adapter } as never,
    notifications as never,
    events as never,
    { get: (k: string) => env[k] } as never,
  );
  return { sweeper, prisma, buffer, harvester, access, adapter, notifications, events, principal, binding };
}

describe('the sweep', () => {
  it('never runs a second sweep while one is in flight', async () => {
    let finish!: () => void;
    const h = harness({ harvest: () => new Promise((r) => (finish = () => r({ proposed: 0, duplicates: 0, dropped: 0 }))) });
    const first = h.sweeper.sweep(NOW);
    await vi.waitFor(() => expect(h.harvester.harvest).toHaveBeenCalledTimes(1));
    expect(await h.sweeper.sweep(NOW)).toBe(0);
    expect(h.buffer.listenedThreads).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(1);
    // Free again once it finished.
    h.harvester.harvest.mockResolvedValue({ proposed: 0, duplicates: 0, dropped: 0 });
    await h.sweeper.sweep(NOW);
    expect(h.buffer.listenedThreads).toHaveBeenCalledTimes(2);
  });

  it('harvests as the admin who turned it on, re-checked as admin, and tells only them, in counts', async () => {
    const h = harness();
    expect(await h.sweeper.sweep(NOW)).toBe(1);
    expect(h.access.principalFor).toHaveBeenCalledWith('admin-1', 'en');
    expect(h.access.requireRole).toHaveBeenCalledWith(h.principal, 'ws', 'admin');
    expect(h.harvester.harvest).toHaveBeenCalledWith(
      {
        workspaceId: 'ws',
        projectId: 'p-1',
        platform: 'telegram',
        chatTitle: 'Platform team',
        thread: expect.objectContaining({ url: 'https://t.me/c/1/41' }),
      },
      h.principal,
    );
    expect(h.notifications.notify).toHaveBeenCalledWith({
      workspaceId: 'ws',
      userIds: ['admin-1'],
      type: 'chat.harvest.proposed',
      reason: 'participant',
      actor: null,
      title: 'Platform team',
      metadata: { bindingId: 'b-1', proposed: 2, duplicates: 1 },
    });
    expect(h.events.announce).toHaveBeenCalledWith('ws', [{ userId: 'admin-1' }]);
    // Nothing in the group: nobody there asked.
    expect(h.adapter.postMessage).not.toHaveBeenCalled();
  });

  it('a harvest that proposed nothing tells nobody', async () => {
    const h = harness({ harvest: async () => ({ proposed: 0, duplicates: 2, dropped: 0 }) });
    expect(await h.sweeper.sweep(NOW)).toBe(1);
    expect(h.notifications.notify).not.toHaveBeenCalled();
  });

  it('an owner who is no longer an admin harvests nothing, and the thread is not marked', async () => {
    const h = harness({
      requireRole: async () => {
        throw new ForbiddenException();
      },
    });
    expect(await h.sweeper.sweep(NOW)).toBe(0);
    expect(h.harvester.harvest).not.toHaveBeenCalled();
    expect(h.prisma.chatHarvestMark.createMany).not.toHaveBeenCalled();
  });

  it('a binding switched off since the snapshot harvests nothing', async () => {
    const h = harness();
    expect(await h.sweeper.harvestThread(thread(), { ...h.binding, autoHarvestBy: null } as never)).toBe('off');
    expect(await h.sweeper.harvestThread(thread(), { ...h.binding, listening: false } as never)).toBe('off');
    expect(h.harvester.harvest).not.toHaveBeenCalled();
  });
});

describe('once per change', () => {
  it('marks a first harvest by inserting the mark at the newest message, before the model is called', async () => {
    const h = harness();
    const order: string[] = [];
    h.prisma.chatHarvestMark.createMany.mockImplementation(async () => (order.push('mark'), { count: 1 }));
    h.harvester.harvest.mockImplementation(async () => (order.push('model'), { proposed: 0, duplicates: 0, dropped: 0 }));
    const t = thread();
    await h.sweeper.sweep(NOW);
    expect(h.prisma.chatHarvestMark.createMany).toHaveBeenCalledWith({
      data: [{ bindingId: 'b-1', topicKey: '', harvestedThrough: t.newestAt }],
      skipDuplicates: true,
    });
    expect(order).toEqual(['mark', 'model']);
  });

  it('moves an existing mark only from where it was read, and reads only what came after it and after the switch', async () => {
    const through = new Date(NOW - 2 * 86_400_000);
    const t = thread({ through });
    const h = harness({ threads: [t] });
    await h.sweeper.sweep(NOW);
    expect(h.prisma.chatHarvestMark.updateMany).toHaveBeenCalledWith({
      where: { bindingId: 'b-1', topicKey: '', harvestedThrough: through },
      data: { harvestedThrough: t.newestAt, harvestedAt: expect.any(Date) },
    });
    expect(h.buffer.listenedThread).toHaveBeenCalledWith(t, through, 200);

    // Never harvested yet: nothing said before the switch went on is read.
    const h2 = harness();
    await h2.sweeper.sweep(NOW);
    expect(h2.buffer.listenedThread).toHaveBeenCalledWith(expect.anything(), AUTO_AT, 200);
  });

  it('a second process (or sweep) over the same snapshot loses the mark and harvests nothing', async () => {
    const h = harness({ claimCount: 0 });
    expect(await h.sweeper.sweep(NOW)).toBe(0);
    expect(h.harvester.harvest).not.toHaveBeenCalled();
  });

  it('a thread with nothing new since its mark is never offered: the query reads past the mark and the switch only', () => {
    const prisma = { $queryRaw: vi.fn(async () => []) };
    const svc = new ChatBufferService(prisma as never, { get: () => 7 } as never);
    void svc.listenedThreads();
    const sql = (prisma.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?');
    expect(sql).toContain('m.created_at > k.harvested_through');
    expect(sql).toContain('m.created_at > b.auto_harvest_at');
    expect(sql).toContain('b.listening AND b.auto_harvest_by IS NOT NULL AND i.enabled');
  });

  it('the hourly rate or the budget puts the mark back for the next tick; any other refusal keeps it', async () => {
    const through = new Date(NOW - 2 * 86_400_000);
    const t = thread({ through });
    for (const err of [new HarvestRefused('chat.harvest.rateLimited'), new HttpException('budget', HttpStatus.TOO_MANY_REQUESTS)]) {
      const h = harness({ threads: [t], harvest: async () => Promise.reject(err) });
      expect(await h.sweeper.harvestThread(t, h.binding as never)).toBe('retry');
      expect(h.prisma.chatHarvestMark.updateMany).toHaveBeenLastCalledWith({
        where: { bindingId: 'b-1', topicKey: '', harvestedThrough: t.newestAt },
        data: { harvestedThrough: through },
      });
    }
    const first = thread();
    const h1 = harness({ harvest: async () => Promise.reject(new HarvestRefused('chat.harvest.rateLimited')) });
    await h1.sweeper.harvestThread(first, h1.binding as never);
    expect(h1.prisma.chatHarvestMark.deleteMany).toHaveBeenCalledWith({ where: { bindingId: 'b-1', topicKey: '', harvestedThrough: first.newestAt } });

    const h2 = harness({ threads: [t], harvest: async () => Promise.reject(new HarvestRefused('chat.capture.capturesOff')) });
    expect(await h2.sweeper.harvestThread(t, h2.binding as never)).toBe('refused');
    expect(h2.prisma.chatHarvestMark.updateMany).toHaveBeenCalledTimes(1); // the claim, never put back
  });
});

describe('reading a listened thread', () => {
  it('reads after the mark up to the newest the sweep saw, and keeps the first and the newest past the cap', async () => {
    const rows = [5, 4, 3].map((n) => ({ externalMessageId: String(n), authorId: 'a', text: `m${n}`, sentAt: new Date(NOW - n * MIN) }));
    const first = { externalMessageId: '1', authorId: 'a', text: 'm1', sentAt: new Date(NOW - 10 * MIN) };
    const prisma = { chatBufferedMessage: { findMany: vi.fn(async () => [...rows]), findFirst: vi.fn(async () => first) } };
    const svc = new ChatBufferService(prisma as never, { get: () => 7 } as never);
    const after = new Date(NOW - 86_400_000);
    const t = thread({ topicKey: '77', fresh: 9 });
    const read = await svc.listenedThread(t, after, 3);
    expect(prisma.chatBufferedMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bindingId: 'b-1', topicId: '77', createdAt: { gt: after, lte: t.newestAt } }, take: 3 }),
    );
    expect(read.thread.truncated).toBe(true);
    expect(read.thread.messages.map((m) => m.text)).toEqual(['m1', 'm4', 'm5']);
    expect(read.firstMessageId).toBe('1');
  });
});

// -----------------------------------------------------------------------------

describe('the switch', () => {
  function integrations(over: Record<string, unknown> = {}, post: () => Promise<unknown> = async () => ({})) {
    const row = {
      id: 'b-1',
      integrationId: 'int-1',
      workspaceId: 'ws',
      externalChatId: '-1001',
      listening: true,
      autoHarvestBy: null as string | null,
      autoHarvestAt: null as Date | null,
      locale: null,
      ...over,
    };
    const prisma = {
      chatChannelBinding: {
        findUnique: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data, _count: { subscriptions: 0 }, createdAt: new Date(), updatedAt: new Date() })),
      },
      chatBufferedMessage: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
    const adapter = { postMessage: vi.fn(post), render: (v: unknown) => v };
    const env: Record<string, unknown> = { API_PUBLIC_URL: 'https://api.test', CHAT_LISTEN_TTL_DAYS: 7, HARVEST_AUTO_QUIET_MINUTES: 60 };
    const audit = { record: vi.fn(async () => undefined) };
    const svc = new ChatIntegrationsService(prisma as never, { get: () => adapter } as never, {} as never, { get: (k: string) => env[k] } as never, {} as never, audit as never);
    vi.spyOn(svc, 'require').mockResolvedValue({ id: 'int-1', kind: 'telegram', locale: 'en' } as never);
    vi.spyOn(svc, 'context').mockReturnValue({ token: 'T' } as never);
    const data = () => (prisma.chatChannelBinding.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    const actions = () => audit.record.mock.calls.map((c) => (c as unknown as [{ action: string }])[0].action);
    return { svc, prisma, adapter, data, audit, actions };
  }

  it('on: tells the group first, and the caller becomes who it runs as', async () => {
    const h = integrations();
    const entry = await h.svc.updateBinding('b-1', { autoHarvest: true }, 'admin-1');
    expect(h.adapter.postMessage).toHaveBeenCalledWith({ token: 'T' }, { chatId: '-1001' }, { kind: 'notice', text: 'chat.listen.autoOn' });
    expect(h.data()).toMatchObject({ autoHarvestBy: 'admin-1', autoHarvestAt: expect.any(Date) });
    expect(entry.autoHarvestBy).toBe('admin-1');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws', actor: 'admin-1', action: 'chat.auto_harvest_enabled', target: 'b-1', params: expect.objectContaining({ quietMinutes: 60 }) }),
    );
  });

  it('already on: another admin pressing it again does not take it over', async () => {
    const h = integrations({ autoHarvestBy: 'admin-1', autoHarvestAt: AUTO_AT });
    await h.svc.updateBinding('b-1', { autoHarvest: true }, 'admin-2');
    expect(h.adapter.postMessage).not.toHaveBeenCalled();
    expect(h.data()).not.toHaveProperty('autoHarvestBy');
    expect(h.audit.record).not.toHaveBeenCalled();
  });

  it('needs listening, and the group told — otherwise it stays off', async () => {
    const off = integrations({ listening: false });
    await expect(off.svc.updateBinding('b-1', { autoHarvest: true }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(off.prisma.chatChannelBinding.update).not.toHaveBeenCalled();

    const kicked = integrations({}, async () => {
      throw new Error('bot was kicked');
    });
    await expect(kicked.svc.updateBinding('b-1', { autoHarvest: true }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(kicked.prisma.chatChannelBinding.update).not.toHaveBeenCalled();
    expect(kicked.audit.record).not.toHaveBeenCalled();
  });

  it('off, or listening off, clears who it ran as', async () => {
    const h = integrations({ autoHarvestBy: 'admin-1', autoHarvestAt: AUTO_AT });
    await h.svc.updateBinding('b-1', { autoHarvest: false }, 'admin-2');
    expect(h.data()).toMatchObject({ autoHarvestBy: null, autoHarvestAt: null });
    expect(h.actions()).toEqual(['chat.auto_harvest_disabled']);

    const l = integrations({ autoHarvestBy: 'admin-1', autoHarvestAt: AUTO_AT });
    await l.svc.updateBinding('b-1', { listening: false }, 'admin-2');
    expect(l.data()).toMatchObject({ listening: false, autoHarvestBy: null, autoHarvestAt: null });
    expect(l.actions()).toEqual(['chat.listen_disabled', 'chat.auto_harvest_disabled']);
  });

  it('the list says what the server allows beside what each binding asks for', async () => {
    const env: Record<string, unknown> = { CHAT_ENABLED: true, HARVEST_ENABLED: true, HARVEST_AUTO_ENABLED: false, HARVEST_AUTO_MIN_MESSAGES: 8, HARVEST_AUTO_QUIET_MINUTES: 60, CHAT_LISTEN_TTL_DAYS: 7, API_PUBLIC_URL: 'x' };
    const prisma = { chatChannelBinding: { findMany: vi.fn(async () => []) }, chatIntegration: { findUnique: vi.fn(async () => ({ id: 'int-1', workspaceId: 'ws' })) } };
    const messages = { settings: vi.fn(async () => ({ available: true, retentionDays: { ceiling: 90, requested: null, applied: 90 } })) };
    const svc = new ChatIntegrationsService(prisma as never, {} as never, {} as never, { get: (k: string) => env[k] } as never, messages as never, { record: vi.fn() } as never);
    expect((await svc.listBindings('int-1')).autoHarvest).toEqual({ available: false, minMessages: 8, quietMinutes: 60 });
  });
});
