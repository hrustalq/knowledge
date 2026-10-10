import { describe, expect, it, vi, afterEach } from 'vitest';
import 'reflect-metadata';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthFlowController } from '../src/auth/auth-flow.controller.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { EventsController } from '../src/events/events.controller.js';
import { EventsSubscriber } from '../src/events/events.subscriber.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { UrlTicketsService, type TicketStore } from '../src/auth/url-tickets.service.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { of } from 'rxjs';

/**
 * Single-use URL tickets (#102, phase 2). What is pinned:
 * - a `kt_` ticket authenticates a `@QueryTokenOk` route exactly once, as the
 *   principal that minted it (API-key narrowing included), and not after its TTL;
 * - a `kn_` API key in `?token=` is refused even on an opted-in route;
 * - a `ks_` session still works there (the web's <img> URLs, until phase 2b);
 * - minting needs a header credential: a ticket cannot mint a ticket.
 */

/** In-memory stand-in for the Redis SET EX / GETDEL pair, with a clock. */
class FakeStore implements TicketStore {
  now = 0;
  private readonly rows = new Map<string, { value: string; until: number }>();
  async set(key: string, value: string, _mode: 'EX', seconds: number) {
    this.rows.set(key, { value, until: this.now + seconds * 1000 });
    return 'OK';
  }
  async getdel(key: string) {
    const row = this.rows.get(key);
    this.rows.delete(key);
    return row && row.until > this.now ? row.value : null;
  }
}

const KEY = 'kn_live_key';
const SESSION = 'ks_live_session';
const keyPrincipal: Principal = {
  ...DEV_PRINCIPAL,
  userId: 'u-key',
  mode: 'api-key',
  isAdmin: false,
  apiKey: { id: 'k1', scope: 'read', workspaceId: 'w1' },
};
const sessionPrincipal: Principal = { ...DEV_PRINCIPAL, userId: 'u-session', mode: 'session', isAdmin: false };

const config = (overrides: Record<string, unknown> = {}) => ({
  get: (k: string) => ({ AUTH_MODE: 'api-key', AUTH_URL_TICKET_TTL_SEC: 60, ...overrides })[k],
});

function tokenAuthFor(store: FakeStore, mode = 'api-key') {
  const tickets = new UrlTicketsService(config({ AUTH_MODE: mode }) as never, store);
  const auth = new TokenAuthService(config({ AUTH_MODE: mode }) as never, {} as never, {} as never, tickets);
  // Header and session resolution are TokenAuthService's existing, separately
  // covered paths; stub them to fixed principals so this spec is about URLs.
  const internals = auth as unknown as Record<string, unknown>;
  internals.resolveApiKey = vi.fn(async (k: string) => {
    if (k === KEY) return keyPrincipal;
    throw new UnauthorizedException('unknown key');
  });
  internals.resolveSession = vi.fn(async (k: string) => {
    if (k === SESSION) return sessionPrincipal;
    throw new UnauthorizedException('bad session');
  });
  return { auth, tickets };
}

describe('UrlTicketsService + TokenAuthService.resolveQueryToken', () => {
  it('redeems a kt_ ticket once, as the principal that minted it', async () => {
    const store = new FakeStore();
    const { auth, tickets } = tokenAuthFor(store);
    const { ticket, expiresAt } = await tickets.mint(keyPrincipal);
    expect(ticket).toMatch(/^kt_[0-9a-f]{48}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    await expect(auth.resolveQueryToken(ticket)).resolves.toEqual(keyPrincipal);
    await expect(auth.resolveQueryToken(ticket)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a ticket after its TTL', async () => {
    const store = new FakeStore();
    const { auth, tickets } = tokenAuthFor(store);
    const { ticket } = await tickets.mint(sessionPrincipal);
    store.now += 61_000;
    await expect(auth.resolveQueryToken(ticket)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an unknown ticket', async () => {
    const { auth } = tokenAuthFor(new FakeStore());
    await expect(auth.resolveQueryToken('kt_' + 'a'.repeat(48))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a valid kn_ API key in a URL', async () => {
    const { auth } = tokenAuthFor(new FakeStore());
    await expect(auth.resolveQueryToken(KEY)).rejects.toBeInstanceOf(UnauthorizedException);
    // …while the same key is fine as a header.
    await expect(auth.resolve(KEY)).resolves.toEqual(keyPrincipal);
  });

  it('still accepts a ks_ session in a URL (<img> redirects, until asset tickets)', async () => {
    const { auth } = tokenAuthFor(new FakeStore());
    await expect(auth.resolveQueryToken(SESSION)).resolves.toEqual(sessionPrincipal);
  });

  it('stores only the hash of the ticket', async () => {
    const set = vi.fn(async () => 'OK');
    const tickets = new UrlTicketsService(config() as never, { set, getdel: vi.fn() });
    const { ticket } = await tickets.mint(sessionPrincipal);
    const [key, , , ttl] = set.mock.calls[0] as unknown as [string, string, string, number];
    expect(key).not.toContain(ticket);
    expect(key).toMatch(/^kn:url-ticket:[0-9a-f]{64}$/);
    expect(ttl).toBe(60);
  });

  it('AUTH_MODE=none resolves the dev principal without touching the store', async () => {
    const store = new FakeStore();
    const getdel = vi.spyOn(store, 'getdel');
    const { auth } = tokenAuthFor(store, 'none');
    await expect(auth.resolveQueryToken('kt_whatever')).resolves.toEqual(DEV_PRINCIPAL);
    expect(getdel).not.toHaveBeenCalled();
  });
});

describe('url tickets over HTTP (real AuthGuard, real controllers)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  const stream = vi.fn(() => of({ data: 'hello' }));

  async function boot() {
    const store = new FakeStore();
    const { auth, tickets } = tokenAuthFor(store);
    const mod = await Test.createTestingModule({
      controllers: [AuthFlowController, EventsController],
      providers: [
        { provide: TokenAuthService, useValue: auth },
        { provide: UrlTicketsService, useValue: tickets },
        { provide: AuthFlowService, useValue: {} },
        { provide: EventsSubscriber, useValue: { stream } },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    return request(app.getHttpServer());
  }

  const W = '11111111-1111-4111-8111-111111111111';

  it('mint with a header, open the SSE stream once with the ticket, then 401', async () => {
    const http = await boot();
    const minted = await http.post('/v1/auth/url-ticket').set('Authorization', `Bearer ${KEY}`);
    expect(minted.status).toBe(200);
    const { ticket } = minted.body as { ticket: string };
    expect(ticket).toMatch(/^kt_/);

    const first = await http.get(`/v1/events?workspaceId=${W}&token=${ticket}`);
    expect(first.status).toBe(200);
    expect(stream).toHaveBeenLastCalledWith(W, 'u-key');

    const replay = await http.get(`/v1/events?workspaceId=${W}&token=${ticket}`);
    expect(replay.status).toBe(401);
  });

  it('a kn_ API key in ?token= on the SSE route is a 401', async () => {
    const http = await boot();
    expect((await http.get(`/v1/events?workspaceId=${W}&token=${KEY}`)).status).toBe(401);
  });

  it('a ticket cannot mint another ticket (the mint route reads headers only)', async () => {
    const http = await boot();
    const { ticket } = (await http.post('/v1/auth/url-ticket').set('Authorization', `Bearer ${SESSION}`)).body as {
      ticket: string;
    };
    expect((await http.post(`/v1/auth/url-ticket?token=${ticket}`)).status).toBe(401);
  });
});
