import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { LiveGateway } from '../src/events/live.gateway.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';

/**
 * The live socket's connection handshake (found in #75 phase 4's live check).
 *
 * What is pinned: a frame the client sends while its token is still being
 * resolved — a `subscribe` from `onopen`, the natural way to write a client —
 * is answered once authentication settles, in the order frames arrived. Before
 * the fix the `message` listener was registered after that await, and `ws`
 * drops a frame nobody listens for: no reply and no error.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const principal: Principal = { ...DEV_PRINCIPAL, mode: 'session', isAdmin: false, userId: 'u1' };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

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
  /** What `ws` does with a frame: hand it to the listeners there are now, or to nobody. */
  receive(frame: object) {
    for (const fn of this.listeners.get('message') ?? []) fn(Buffer.from(JSON.stringify(frame)));
  }
}

function gateway() {
  const auth = deferred<Principal>();
  const tokenAuth = { resolve: vi.fn(() => auth.promise), blocksUnverified: () => false };
  const access = { requireRole: vi.fn(async () => 'viewer') };
  const config = {
    get: (k: string) => ({ LIVE_WS_ENABLED: true, LIVE_TRACKED_EVENTS: '', LIVE_WS_MAX_SUBSCRIPTIONS: 10 })[k],
  };
  const gw = new LiveGateway(config as never, tokenAuth as never, access as never, {} as never, {} as never);
  const socket = new FakeSocket();
  const connected = gw.handleConnection(socket as never, { url: '/v1/events/ws?token=ks_x', headers: {} } as never);
  return { auth, access, socket, connected };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('LiveGateway handshake', () => {
  it('answers a subscribe sent before the token resolved, once it has', async () => {
    const g = gateway();
    g.socket.receive({ type: 'subscribe', workspaceId: WS });
    await settle();
    expect(g.socket.sent).toEqual([]);
    expect(g.access.requireRole).not.toHaveBeenCalled();

    g.auth.resolve(principal);
    await g.connected;
    await settle();
    expect(g.access.requireRole).toHaveBeenCalledWith(principal, WS, 'viewer');
    expect(g.socket.sent).toEqual([expect.objectContaining({ type: 'subscribed', workspaceId: WS })]);
  });

  it('keeps early frames in arrival order', async () => {
    const g = gateway();
    g.socket.receive({ type: 'ping' });
    g.socket.receive({ type: 'subscribe', workspaceId: WS });
    g.auth.resolve(principal);
    await g.connected;
    await settle();
    expect(g.socket.sent.map((m) => m.type)).toEqual(['pong', 'subscribed']);
  });

  it('discards early frames when authentication fails, and closes 4401', async () => {
    const g = gateway();
    g.socket.receive({ type: 'subscribe', workspaceId: WS });
    g.auth.reject(new UnauthorizedException('no'));
    await g.connected;
    await settle();
    expect(g.socket.close).toHaveBeenCalledWith(4401, 'authentication failed');
    expect(g.access.requireRole).not.toHaveBeenCalled();
    expect(g.socket.sent.map((m) => m.type)).toEqual(['error']);
  });
});
