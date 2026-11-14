import { afterEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { LiveGateway } from '../src/events/live.gateway.js';
import { EventsController } from '../src/events/events.controller.js';
import { LIVE_RECHECK_MS } from '../src/events/live-recheck.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';

/**
 * #1097: a live stream is re-judged while it is open, not only when it opens.
 * Logout, a revoked key, a disabled account or removal from the workspace ends
 * delivery within one tick — a page frame was already re-judged per frame, but
 * a workspace-level frame went to every subscribed socket indefinitely. And
 * the upgrade URL takes only a single-use `kt_` ticket, as `?token=` on HTTP
 * does: a `kn_`/`ks_` credential in a URL ends up in access logs.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const principal: Principal = { ...DEV_PRINCIPAL, mode: 'session', isAdmin: false, userId: 'u1', sessionId: 's1' };

class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  sent: Record<string, unknown>[] = [];
  close = vi.fn();
  send = vi.fn((data: string) => this.sent.push(JSON.parse(data) as Record<string, unknown>));
  on(event: string, fn: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }
  receive(frame: object) {
    for (const fn of this.listeners.get('message') ?? []) fn(Buffer.from(JSON.stringify(frame)));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function gateway() {
  const tokenAuth = {
    resolve: vi.fn(async () => principal),
    resolveTicket: vi.fn(async (token?: string) => {
      if (token?.startsWith('kt_')) return principal;
      throw new UnauthorizedException('credential in url');
    }),
    isCurrent: vi.fn(async () => true),
    blocksUnverified: () => false,
  };
  const access = { requireRole: vi.fn(async () => 'viewer') };
  const config = { get: (k: string) => ({ LIVE_WS_ENABLED: true, LIVE_TRACKED_EVENTS: '*', LIVE_WS_MAX_SUBSCRIPTIONS: 10 })[k] };
  const gw = new LiveGateway(config as never, tokenAuth as never, access as never, {} as never, {} as never);
  const connect = async (url: string, headers: Record<string, string> = {}) => {
    const socket = new FakeSocket();
    await gw.handleConnection(socket as never, { url, headers } as never);
    await settle();
    return socket;
  };
  return { gw, tokenAuth, access, connect };
}

describe('live socket re-check (#1097)', () => {
  it('closes a socket whose credential no longer stands, within one tick', async () => {
    const g = gateway();
    const socket = await g.connect('/v1/events/ws', { authorization: 'Bearer ks_x' });
    socket.receive({ type: 'subscribe', workspaceId: WS });
    await settle();
    expect(socket.close).not.toHaveBeenCalled();

    g.tokenAuth.isCurrent.mockResolvedValue(false);
    await g.gw.recheck();
    expect(socket.close).toHaveBeenCalledWith(4401, 'authentication failed');
  });

  it('drops a subscription to a workspace the person was removed from, and keeps the socket', async () => {
    const g = gateway();
    const socket = await g.connect('/v1/events/ws', { authorization: 'Bearer ks_x' });
    socket.receive({ type: 'subscribe', workspaceId: WS });
    await settle();

    g.access.requireRole.mockRejectedValue(new ForbiddenException('not a member'));
    await g.gw.recheck();
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.sent.map((m) => m.type)).toEqual(['subscribed', 'error', 'unsubscribed']);
  });

  it('refuses a kn_ key or ks_ session in the upgrade URL, and takes a kt_ ticket', async () => {
    const g = gateway();
    for (const token of ['kn_live', 'ks_live']) {
      const socket = await g.connect(`/v1/events/ws?token=${token}`);
      expect(socket.close).toHaveBeenCalledWith(4401, 'authentication failed');
    }
    expect(g.tokenAuth.resolve).not.toHaveBeenCalledWith('kn_live');
    expect(g.tokenAuth.resolve).not.toHaveBeenCalledWith('ks_live');
    const ok = await g.connect('/v1/events/ws?token=kt_ticket');
    expect(ok.close).not.toHaveBeenCalled();
  });
});

describe('SSE stream re-check (#1097)', () => {
  afterEach(() => vi.useRealTimers());

  it('ends the stream once the credential no longer stands', async () => {
    vi.useFakeTimers();
    const upstream = new Subject<{ data: unknown }>();
    const subscriber = { stream: vi.fn(() => upstream.asObservable()) };
    const tokenAuth = { isCurrent: vi.fn(async () => true) };
    const access = { requireRole: vi.fn(async () => 'viewer') };
    const controller = new EventsController(subscriber as never, { observe: () => undefined, allows: async () => [true] } as never, tokenAuth as never, access as never);
    let completed = false;
    const seen: unknown[] = [];
    controller.events(WS, principal).subscribe({ next: (m) => seen.push(m), complete: () => (completed = true) });

    upstream.next({ data: 'one' });
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    expect(completed).toBe(false);

    tokenAuth.isCurrent.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    expect(completed).toBe(true);
    upstream.next({ data: 'two' });
    expect(seen).toEqual([{ data: 'one' }]);
  });

  it('ends the stream once the person left the workspace', async () => {
    vi.useFakeTimers();
    const upstream = new Subject<{ data: unknown }>();
    const tokenAuth = { isCurrent: vi.fn(async () => true) };
    const access = { requireRole: vi.fn(async () => 'viewer') };
    const controller = new EventsController({ stream: () => upstream.asObservable() } as never, {} as never, tokenAuth as never, access as never);
    let completed = false;
    controller.events(WS, principal).subscribe({ complete: () => (completed = true) });
    access.requireRole.mockRejectedValue(new ForbiddenException('removed'));
    await vi.advanceTimersByTimeAsync(LIVE_RECHECK_MS);
    expect(completed).toBe(true);
  });
});
