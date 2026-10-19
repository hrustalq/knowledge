import { describe, expect, it, vi } from 'vitest';
import { ANALYTICS_CHANNELS, TRAFFIC_CLASSES, channelsForTrafficClass, trafficClassFor } from '@knowledge/contracts';
import { AnalyticsRecorder, channelFor, foldQuery, noTrackOf, queryHashOf } from '../src/analytics/analytics.recorder.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';

const WS = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

const session: Principal = { ...DEV_PRINCIPAL, userId: 'u-1', mode: 'session', isAdmin: false };
const key: Principal = { ...session, mode: 'api-key', apiKey: { id: 'k-1', scope: 'read', workspaceId: null } };
/** A background run's owner, as AccessService.principalFor rehydrates it. */
const runOwner: Principal = { ...session, mode: 'api-key' };

function recorder(opts: { env?: Record<string, unknown>; settings?: { analyticsEnabled: boolean | null } | null } = {}) {
  const env: Record<string, unknown> = {
    ANALYTICS_ENABLED: true,
    ANALYTICS_READER_SECRET: 'secret',
    SETTINGS_ENCRYPTION_KEY: '',
    ...opts.env,
  };
  const prisma = {
    workspaceSettings: { findUnique: vi.fn(async () => opts.settings ?? null) },
    document: { findUnique: vi.fn(async () => ({ workspaceId: WS, projectId: 'p-1' })) },
    searchQuery: { create: vi.fn(async () => ({})) },
    pageView: { create: vi.fn(async () => ({})) },
    mcpToolCall: { create: vi.fn(async () => ({})) },
  };
  const config = { get: (k: string) => env[k] };
  return { rec: new AnalyticsRecorder(prisma as never, config as never), prisma };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('traffic classes', () => {
  it('derives a class for every channel, and the inverse returns exactly those channels', () => {
    for (const cls of TRAFFIC_CLASSES) {
      for (const ch of channelsForTrafficClass(cls)) expect(trafficClassFor(ch)).toBe(cls);
    }
    expect(TRAFFIC_CLASSES.flatMap(channelsForTrafficClass).sort()).toEqual([...ANALYTICS_CHANNELS].sort());
    expect(channelsForTrafficClass('human')).toEqual(['web']);
    expect(channelsForTrafficClass('assisted')).toEqual(['assistant', 'chat']);
  });
});

describe('channelFor', () => {
  it('lets a named surface win, then tells a run owner from a key from a person', () => {
    expect(channelFor({ principal: key, channel: 'mcp' })).toBe('mcp');
    expect(channelFor({ principal: key })).toBe('api');
    expect(channelFor({ principal: runOwner })).toBe('agent');
    expect(channelFor({ principal: session })).toBe('web');
    expect(channelFor({ principal: DEV_PRINCIPAL })).toBe('web');
  });

  it('reads DNT and GPC', () => {
    expect(noTrackOf({ dnt: '1' })).toBe(true);
    expect(noTrackOf({ 'sec-gpc': '1' })).toBe(true);
    expect(noTrackOf({ dnt: '0' })).toBe(false);
  });
});

describe('AnalyticsRecorder', () => {
  it('keys a reader per workspace, and drops the key under DNT/GPC', () => {
    const { rec } = recorder();
    const a = rec.readerKey({ principal: session }, WS);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.readerKey({ principal: session }, WS)).toBe(a);
    expect(rec.readerKey({ principal: session }, WS_B)).not.toBe(a);
    expect(rec.readerKey({ principal: { ...session, userId: 'u-2' } }, WS)).not.toBe(a);
    expect(rec.readerKey({ principal: session, noTrack: true }, WS)).toBeNull();
  });

  it('files a search with folded text, a stable hash, the top 10 pages and the channel', async () => {
    const { rec, prisma } = recorder();
    const ids = Array.from({ length: 12 }, (_, i) => `d-${i}`);
    const id = rec.search({ principal: key }, { workspaceId: WS, query: '  Billing\n  API ', mode: 'hybrid', projectIds: [], resultDocIds: ids, durationMs: 12.4 });
    await flush();
    expect(prisma.searchQuery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id,
        queryText: 'Billing API',
        queryHash: queryHashOf('Billing API'),
        resultCount: 12,
        resultDocIds: ids.slice(0, 10),
        channel: 'api',
        apiKeyId: 'k-1',
        durationMs: 12,
        readerKey: expect.stringMatching(/^[0-9a-f]{32}$/),
      }),
    });
    expect(queryHashOf(foldQuery('billing   api'))).toBe(queryHashOf(foldQuery('Billing API')));
  });

  it('never stores a reader under DNT/GPC, but still counts the event', async () => {
    const { rec, prisma } = recorder();
    rec.search({ principal: session, noTrack: true }, { workspaceId: WS, query: 'q', mode: 'hybrid', projectIds: [], resultDocIds: [], durationMs: 1 });
    await rec.view({ principal: key, noTrack: true }, DOC);
    await flush();
    expect(prisma.searchQuery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ readerKey: null, resultCount: 0 }) });
    expect(prisma.pageView.create).toHaveBeenCalledWith({ data: expect.objectContaining({ readerKey: null }) });
  });

  it('records a non-web read with its page\'s workspace and project, and drops a web read', async () => {
    const { rec, prisma } = recorder();
    await rec.view({ principal: session }, DOC);
    expect(prisma.pageView.create).not.toHaveBeenCalled();
    await rec.view({ principal: session, channel: 'assistant' }, DOC, 'rev-1');
    expect(prisma.pageView.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: WS, projectId: 'p-1', documentId: DOC, revisionId: 'rev-1', channel: 'assistant' }),
    });
  });

  it('resolves a tool call\'s workspace from the page it named', async () => {
    const { rec, prisma } = recorder();
    await rec.toolCall({ principal: key, channel: 'mcp' }, { tool: 'knowledge_get_document', workspaceId: null, documentId: DOC, ok: true, errorCode: null, durationMs: 3 });
    await rec.toolCall({ principal: key, channel: 'mcp' }, { tool: 'knowledge_whoami', workspaceId: null, ok: true, errorCode: null, durationMs: 1 });
    expect(prisma.mcpToolCall.create.mock.calls.map(([a]) => (a as { data: { workspaceId: unknown } }).data.workspaceId)).toEqual([WS, null]);
  });

  it('writes nothing with ANALYTICS_ENABLED=false, and the search gets no id', async () => {
    const { rec, prisma } = recorder({ env: { ANALYTICS_ENABLED: false } });
    expect(rec.search({ principal: key }, { workspaceId: WS, query: 'q', mode: 'hybrid', projectIds: [], resultDocIds: [], durationMs: 1 })).toBeNull();
    await rec.view({ principal: key }, DOC);
    await rec.toolCall({ principal: key, channel: 'mcp' }, { tool: 't', workspaceId: WS, ok: true, errorCode: null, durationMs: 1 });
    await flush();
    expect(prisma.searchQuery.create).not.toHaveBeenCalled();
    expect(prisma.pageView.create).not.toHaveBeenCalled();
    expect(prisma.mcpToolCall.create).not.toHaveBeenCalled();
  });

  it('honours a workspace that turned it off, and caches the setting', async () => {
    const { rec, prisma } = recorder({ settings: { analyticsEnabled: false } });
    await rec.view({ principal: key }, DOC);
    await rec.view({ principal: key }, DOC);
    expect(prisma.pageView.create).not.toHaveBeenCalled();
    expect(prisma.workspaceSettings.findUnique).toHaveBeenCalledOnce();
  });

  it('never throws into the caller when a write fails', async () => {
    const { rec, prisma } = recorder();
    prisma.pageView.create.mockRejectedValue(new Error('db down'));
    prisma.searchQuery.create.mockRejectedValue(new Error('db down'));
    await expect(rec.view({ principal: key }, DOC)).resolves.toBeUndefined();
    expect(() =>
      rec.search({ principal: key }, { workspaceId: WS, query: 'q', mode: 'hybrid', projectIds: [], resultDocIds: [], durationMs: 1 }),
    ).not.toThrow();
    await flush();
  });
});
