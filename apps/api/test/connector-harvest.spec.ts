import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorContext, HarvestItem } from '../src/connectors/adapters/connector.types.js';

vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { LinearAdapter, linearSignature } = await import('../src/connectors/adapters/linear.adapter.js');
const { ConnectorHarvestSweeper, capMessages, harvestLabelFor, qualifies } = await import('../src/connectors/harvest/connector-harvest.sweeper.js');
const { HarvestRefused } = await import('../src/chat/harvest.service.js');

/**
 * Harvest connectors (#382, doc 59). The Linear adapter on Linear's documented
 * webhook shape — `Linear-Signature`, `webhookTimestamp`, `actor`,
 * `updatedFrom` — and its GraphQL read; then the claim and the sweeper:
 * once per item, as the person who resolved it when they are a mapped editor
 * now, and only for an item still resolved and labelled when it is read.
 */

const SECRET = 'lin_wh_secret';
const NOW = 1_792_600_000_000;
const ctx = { credential: 'lin_api_key', webhookSecret: SECRET, allowPrivate: false, debug: () => undefined } as unknown as ConnectorContext;

function delivery(over: Record<string, unknown> = {}, at = NOW) {
  const body = JSON.stringify({
    action: 'update',
    type: 'Issue',
    actor: { id: 'lin-user-1', type: 'user', name: 'Ann', email: 'ann@example.test' },
    data: { id: 'issue-uuid-1', identifier: 'ENG-12' },
    updatedFrom: { stateId: 'state-in-progress', updatedAt: '2026-10-22T10:00:00.000Z' },
    url: 'https://linear.app/acme/issue/ENG-12',
    webhookTimestamp: at,
    ...over,
  });
  return { headers: { 'linear-signature': linearSignature(SECRET, body) }, body };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Linear deliveries', () => {
  const verify = (d: { headers: Record<string, string>; body: string }, c = ctx) => {
    vi.useFakeTimers({ now: NOW });
    return new LinearAdapter().verifyHarvestDelivery(c, d.headers, d.body);
  };

  it('a signed state change by a person names the issue and who changed it', () => {
    expect(verify(delivery())).toEqual({
      item: { externalId: 'issue-uuid-1', actor: { externalId: 'lin-user-1', name: 'Ann', email: 'ann@example.test' } },
    });
  });

  it('refuses an unsigned, forged, tampered, replayed or secret-less delivery', () => {
    const d = delivery();
    expect(verify({ headers: {}, body: d.body })).toBeNull();
    expect(verify({ headers: { 'linear-signature': linearSignature('other', d.body) }, body: d.body })).toBeNull();
    expect(verify({ headers: d.headers, body: d.body.replace('ENG-12', 'ENG-13') })).toBeNull();
    expect(verify(delivery({}, NOW - 61_000))).toBeNull();
    expect(verify(d, { ...ctx, webhookSecret: null })).toBeNull();
  });

  it('anything but a person changing an issue’s state is verified and nothing', () => {
    expect(verify(delivery({ updatedFrom: { title: 'old' } }))).toEqual({ item: null });
    expect(verify(delivery({ type: 'Comment' }))).toEqual({ item: null });
    expect(verify(delivery({ action: 'create' }))).toEqual({ item: null });
    expect(verify(delivery({ actor: { id: 'app-1', type: 'integration' } }))).toEqual({ item: null });
    expect(verify(delivery({ actor: null }))).toEqual({ item: null });
  });
});

describe('Linear reads', () => {
  function stub(data: unknown, status = 200) {
    const fetchMock = vi.mocked(safeFetch);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify(data), { status }));
    return fetchMock;
  }

  it('reads the issue fresh: completed or not, its labels, its description and comments as one thread', async () => {
    const fetchMock = stub({
      data: {
        issue: {
          identifier: 'ENG-12',
          title: 'Pin node 22',
          url: 'https://linear.app/acme/issue/ENG-12',
          description: 'Builds break on 22.4',
          createdAt: '2026-10-20T10:00:00.000Z',
          creator: { id: 'u-1' },
          state: { type: 'completed' },
          labels: { nodes: [{ name: 'Knowledge' }, { name: 'infra' }] },
          comments: {
            nodes: [
              { body: 'Fixed by pinning 22.5', createdAt: '2026-10-21T10:00:00.000Z', user: { id: 'u-2' } },
              { body: ' ', createdAt: '2026-10-21T11:00:00.000Z', user: { id: 'u-2' } },
              { body: 'bot note', createdAt: '2026-10-21T09:00:00.000Z', user: null },
            ],
          },
        },
      },
    });
    const item = await new LinearAdapter().readHarvestItem(ctx, 'issue-uuid-1');
    expect(item).toMatchObject({ key: 'ENG-12', title: 'Pin node 22', resolved: true, labels: ['Knowledge', 'infra'] });
    expect(item!.messages.map((m) => [m.authorId, m.text])).toEqual([
      ['u-1', 'Builds break on 22.4'],
      ['u-2', 'Fixed by pinning 22.5'],
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    // Linear takes a personal key bare, not as a Bearer token.
    expect((init.headers as Record<string, string>).authorization).toBe('lin_api_key');
    expect(JSON.parse(init.body as string).variables).toEqual({ id: 'issue-uuid-1' });
  });

  it('an issue gone or out of the key’s reach is nothing; any other error throws', async () => {
    stub({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'INPUT_ERROR' } }] });
    expect(await new LinearAdapter().readHarvestItem(ctx, 'x')).toBeNull();
    stub({ errors: [{ message: 'Entity not found: Issue', extensions: { code: 'ENTITY_NOT_FOUND' } }] }, 400);
    expect(await new LinearAdapter().readHarvestItem(ctx, 'x')).toBeNull();
    stub({ errors: [{ message: 'Authentication required' }] });
    await expect(new LinearAdapter().readHarvestItem(ctx, 'x')).rejects.toThrow('linear: Authentication required');
  });
});

describe('what qualifies', () => {
  const item = (over: Partial<HarvestItem> = {}): HarvestItem => ({
    key: 'ENG-1',
    title: 't',
    url: 'u',
    resolved: true,
    labels: ['Knowledge'],
    messages: [{ authorId: 'a', text: 'x', at: new Date() }],
    ...over,
  });

  it('resolved, carrying the label in any case, with something said', () => {
    expect(qualifies(item(), 'knowledge')).toBe(true);
    expect(qualifies(item({ resolved: false }), 'knowledge')).toBe(false);
    expect(qualifies(item({ labels: ['docs'] }), 'knowledge')).toBe(false);
    expect(qualifies(item({ messages: [] }), 'knowledge')).toBe(false);
    expect(qualifies(null, 'knowledge')).toBe(false);
  });

  it('the label is the connector’s, else knowledge', () => {
    expect(harvestLabelFor({ config: { harvestLabel: ' Runbook ' } })).toBe('runbook');
    expect(harvestLabelFor({ config: {} })).toBe('knowledge');
  });

  it('a long thread keeps its first message and the newest ones', () => {
    expect(capMessages([1, 2, 3, 4, 5], 3)).toEqual({ kept: [1, 4, 5], truncated: true });
    expect(capMessages([1, 2], 3)).toEqual({ kept: [1, 2], truncated: false });
  });
});

describe('the claim and the sweeper', () => {
  const connector = {
    id: 'c-1',
    workspaceId: 'ws-1',
    projectId: 'p-1',
    kind: 'linear',
    enabled: true,
    config: { harvestLabel: 'knowledge' },
  };
  const resolved: HarvestItem = {
    key: 'ENG-12',
    title: 'Pin node 22',
    url: 'https://linear.app/acme/issue/ENG-12',
    resolved: true,
    labels: ['knowledge'],
    messages: [
      { authorId: 'u-1', text: 'Builds break', at: new Date('2026-10-20T10:00:00Z') },
      { authorId: 'u-2', text: 'Pin 22.5', at: new Date('2026-10-21T10:00:00Z') },
    ],
  };

  function harness(opts: { userId?: string | null; role?: boolean; item?: HarvestItem | null; harvest?: () => Promise<unknown>; leased?: number } = {}) {
    const prisma = {
      connectorHarvest: {
        createMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: opts.leased ?? 1 })),
        update: vi.fn(async () => ({})),
        deleteMany: vi.fn(async () => ({ count: 1 })),
      },
      externalIdentity: { findUnique: vi.fn(async () => (opts.userId === null ? null : { userId: opts.userId ?? 'user-ann' })) },
      user: { findUnique: vi.fn(async () => ({ locale: 'ru' })) },
    };
    const readHarvestItem = vi.fn(async () => (opts.item === undefined ? resolved : opts.item));
    const connectors = { adapterFor: () => ({ readHarvestItem }), contextFor: vi.fn(async () => ctx) };
    const acl = { userFor: vi.fn(async () => 'user-ann') };
    const principal = { userId: 'user-ann', locale: 'ru' };
    const access = {
      principalFor: vi.fn(async () => principal),
      requireRole: vi.fn(async () => {
        if (opts.role === false) throw new Error('forbidden');
      }),
    };
    const harvester = { harvest: vi.fn(opts.harvest ?? (async () => ({ proposed: 2, duplicates: 1, dropped: 0 }))) };
    const notifications = { notify: vi.fn(async () => []) };
    const events = { announce: vi.fn(async () => undefined) };
    const config = { get: (k: string) => (k === 'HARVEST_MAX_MESSAGES' ? 200 : true) };
    const sweeper = new ConnectorHarvestSweeper(
      prisma as never,
      connectors as never,
      acl as never,
      access as never,
      harvester as never,
      notifications as never,
      events as never,
      config as never,
    );
    const row = { id: 'h-1', workspaceId: 'ws-1', connectorId: 'c-1', externalId: 'issue-uuid-1', actorId: 'lin-user-1', lockedAt: null, harvestedAt: null, connector };
    return { sweeper, prisma, acl, access, harvester, notifications, readHarvestItem, row: row as never };
  }

  it('the claim records the person and inserts one row per item; a second claim inserts nothing', async () => {
    const h = harness();
    const item = { externalId: 'issue-uuid-1', actor: { externalId: 'lin-user-1', email: 'ann@example.test' } };
    expect(await h.sweeper.claim(connector as never, item)).toBe(true);
    expect(h.acl.userFor).toHaveBeenCalledWith(connector, item.actor);
    expect(h.prisma.connectorHarvest.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: 'ws-1', connectorId: 'c-1', externalId: 'issue-uuid-1', actorId: 'lin-user-1' }],
      skipDuplicates: true,
    });
    h.prisma.connectorHarvest.createMany.mockResolvedValueOnce({ count: 0 });
    expect(await h.sweeper.claim(connector as never, item)).toBe(false);
  });

  it('harvests a resolved, labelled item as the mapped editor who resolved it, then tells them the counts', async () => {
    const h = harness();
    expect(await h.sweeper.finish(h.row)).toBe('harvested');
    expect(h.access.principalFor).toHaveBeenCalledWith('user-ann', 'ru');
    expect(h.access.requireRole).toHaveBeenCalledWith(expect.anything(), 'ws-1', 'editor');
    expect(h.harvester.harvest).toHaveBeenCalledWith(
      {
        workspaceId: 'ws-1',
        projectId: 'p-1',
        platform: 'linear',
        chatTitle: 'ENG-12 · Pin node 22',
        thread: { messages: resolved.messages, url: resolved.url, truncated: false },
      },
      expect.objectContaining({ userId: 'user-ann' }),
    );
    expect(h.prisma.connectorHarvest.update).toHaveBeenCalledWith({
      where: { id: 'h-1' },
      data: expect.objectContaining({ userId: 'user-ann', proposed: 2, duplicates: 1 }),
    });
    expect(h.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['user-ann'], type: 'connector.harvest.proposed', title: 'ENG-12 · Pin node 22', metadata: { connectorId: 'c-1', proposed: 2, duplicates: 1 } }),
    );
  });

  it.each([
    ['an unmapped person', { userId: null }],
    ['a person who is no longer an editor', { role: false }],
    ['an issue reopened since', { item: { ...resolved, resolved: false } }],
    ['an issue whose label was removed', { item: { ...resolved, labels: [] } }],
    ['an issue gone', { item: null }],
  ])('releases the claim, harvesting nothing, for %s', async (_, opts) => {
    const h = harness(opts as never);
    expect(await h.sweeper.finish(h.row)).toBe('released');
    expect(h.harvester.harvest).not.toHaveBeenCalled();
    expect(h.prisma.connectorHarvest.deleteMany).toHaveBeenCalledWith({ where: { id: 'h-1', harvestedAt: null } });
  });

  it('a row another process holds is left to it', async () => {
    const h = harness({ leased: 0 });
    expect(await h.sweeper.finish(h.row)).toBe('leased');
    expect(h.readHarvestItem).not.toHaveBeenCalled();
  });

  it('the person’s hourly rate puts the row back for a later tick; a refusal that will not pass releases it', async () => {
    const limited = harness({ harvest: async () => Promise.reject(new HarvestRefused('chat.harvest.rateLimited')) });
    expect(await limited.sweeper.finish(limited.row)).toBe('retry');
    expect(limited.prisma.connectorHarvest.updateMany).toHaveBeenLastCalledWith({ where: { id: 'h-1', harvestedAt: null }, data: { lockedAt: null } });
    const off = harness({ harvest: async () => Promise.reject(new HarvestRefused('chat.capture.capturesOff')) });
    expect(await off.sweeper.finish(off.row)).toBe('released');
  });

  it('nothing proposed, nobody told', async () => {
    const h = harness({ harvest: async () => ({ proposed: 0, duplicates: 2, dropped: 0 }) });
    expect(await h.sweeper.finish(h.row)).toBe('harvested');
    expect(h.notifications.notify).not.toHaveBeenCalled();
  });
});

describe('the connector webhook, for a harvest connector', () => {
  async function controller() {
    const { ConnectorWebhookController } = await import('../src/connectors/connector-webhook.controller.js');
    const row = { id: 'c-1', workspaceId: 'ws-1', kind: 'linear', enabled: true, webhookSecret: 'sealed', config: {} };
    const claim = vi.fn(async () => true);
    const enqueue = vi.fn();
    const ctl = new ConnectorWebhookController(
      { require: vi.fn(async () => row), contextFor: vi.fn(async () => ctx), adapterFor: () => new LinearAdapter() } as never,
      { enqueue } as never,
      {} as never,
      { trackerFor: () => null } as never,
      {} as never,
      { claim } as never,
      { get: () => 0 } as never,
    );
    return { ctl, claim, enqueue, row };
  }
  const req = (body: string) => ({ rawBody: Buffer.from(body) }) as never;

  it('claims a verified resolution and starts no sync', async () => {
    const { ctl, claim, enqueue, row } = await controller();
    const d = delivery({}, Date.now());
    await expect(ctl.receive('c-1', d.headers, req(d.body))).resolves.toEqual({ accepted: true, runId: null });
    expect(claim).toHaveBeenCalledWith(row, expect.objectContaining({ externalId: 'issue-uuid-1' }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('401s a forged delivery and claims nothing', async () => {
    const { UnauthorizedException } = await import('@nestjs/common');
    const { ctl, claim } = await controller();
    const d = delivery({}, Date.now());
    await expect(ctl.receive('c-1', { 'linear-signature': linearSignature('forged', d.body) }, req(d.body))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(claim).not.toHaveBeenCalled();
  });
});
