import { describe, expect, it, vi, afterEach } from 'vitest';
import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Controller, Get, Post, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { redactUrl } from '@knowledge/observability';
import { AuthGuard } from '../src/auth/auth.guard.js';
import {
  COOKIE_TOKEN_OK_META,
  CookieTokenOk,
  CurrentPrincipal,
  QUERY_TOKEN_OK_META,
  QueryTokenOk,
  ReadKeyOk,
} from '../src/auth/access.decorator.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { LiveGateway } from '../src/events/live.gateway.js';

/**
 * `?token=` query auth is opt-in per route (#102). What is pinned:
 * - AuthGuard ignores a query token on any route without @QueryTokenOk, so a
 *   valid key in the URL of a read or write route is a 401;
 * - the opted-in routes still authenticate from ?token=, and a header still
 *   wins everywhere;
 * - the <img> redirects (@CookieTokenOk) authenticate from the kn_token
 *   session cookie instead, which every other route ignores (#102 phase 2b);
 * - both allowlists: the SSE stream for ?token=, the <img> redirects for the cookie;
 * - the live WebSocket keeps its own ?token= path (not behind AuthGuard);
 * - token values are masked in logged URLs.
 */

const GOOD = 'kn_good_key';
/** What a query token may be (#102 phase 2): a kt_ ticket. */
const GOOD_QUERY = 'kt_good_ticket';
/** What the kn_token cookie may be (#102 phase 2b): a ks_ session. */
const GOOD_COOKIE = 'ks_good_session';
const principal: Principal = { ...DEV_PRINCIPAL, mode: 'api-key', isAdmin: false, userId: 'u1' };

/** api-key mode: GOOD resolves, anything else (or nothing) is a 401. */
const tokenAuth = {
  blocksUnverified: () => false,
  resolve: vi.fn(async (token: string | undefined) => {
    if (token === GOOD) return principal;
    throw new UnauthorizedException('no');
  }),
  // The real rules (only kt_ in URLs, only ks_ in the cookie) are pinned in
  // url-tickets.spec.ts.
  resolveTicket: vi.fn(async (token: string) => {
    if (token === GOOD_QUERY) return principal;
    throw new UnauthorizedException('no');
  }),
  resolveSessionCookie: vi.fn(async (token: string) => {
    if (token === GOOD_COOKIE) return principal;
    throw new UnauthorizedException('no');
  }),
};

// Stand-ins shaped like the real routes: markdown / llms-full reads, a write,
// and one opted-in redirect-style read.
@Controller('v1')
class ProbeController {
  @Get('documents/:id/markdown')
  markdown(@CurrentPrincipal() p: Principal) {
    return { userId: p.userId };
  }

  @Get('workspaces/:id/llms-full.txt')
  llmsFull() {
    return 'ok';
  }

  @Post('documents')
  @ReadKeyOk()
  create() {
    return { created: true };
  }

  @Get('stream')
  @QueryTokenOk()
  stream(@CurrentPrincipal() p: Principal) {
    return { userId: p.userId };
  }

  @Get('asset')
  @CookieTokenOk()
  asset(@CurrentPrincipal() p: Principal) {
    return { userId: p.userId };
  }
}

@Controller('v1/opted-class')
@QueryTokenOk()
class OptedClassController {
  @Get()
  read() {
    return 'ok';
  }
}

describe('AuthGuard ?token= scope', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  async function boot() {
    const mod = await Test.createTestingModule({
      controllers: [ProbeController, OptedClassController],
      providers: [
        { provide: TokenAuthService, useValue: tokenAuth },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    return request(app.getHttpServer());
  }

  it.each([
    ['get', '/v1/documents/d1/markdown'],
    ['get', '/v1/workspaces/w1/llms-full.txt'],
    ['post', '/v1/documents'],
  ] as const)('%s %s with a valid credential in ?token= or the cookie and no header → 401', async (method, path) => {
    const http = await boot();
    expect((await http[method](`${path}?token=${GOOD}`)).status).toBe(401);
    expect((await http[method](`${path}?token=${GOOD_QUERY}`)).status).toBe(401);
    expect((await http[method](path).set('Cookie', `kn_token=${GOOD_COOKIE}`)).status).toBe(401);
  });

  it('the same routes still accept the key as a Bearer header', async () => {
    const http = await boot();
    const res = await http.get('/v1/documents/d1/markdown').set('Authorization', `Bearer ${GOOD}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1' });
  });

  it('an opted-in route authenticates from ?token=', async () => {
    const http = await boot();
    const res = await http.get(`/v1/stream?token=${GOOD_QUERY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1' });
  });

  it('class-level @QueryTokenOk covers its handlers', async () => {
    const http = await boot();
    expect((await http.get(`/v1/opted-class?token=${GOOD_QUERY}`)).status).toBe(200);
  });

  it('a Bearer header wins over ?token= and the cookie on an opted-in route', async () => {
    const http = await boot();
    expect((await http.get('/v1/stream?token=kt_other').set('Authorization', `Bearer ${GOOD}`)).status).toBe(200);
    expect((await http.get('/v1/asset').set('Cookie', 'kn_token=ks_other').set('Authorization', `Bearer ${GOOD}`)).status).toBe(200);
  });

  it('an opted-in route with a bad query token is still a 401', async () => {
    const http = await boot();
    expect((await http.get('/v1/stream?token=kt_bad')).status).toBe(401);
  });

  it('a @CookieTokenOk route authenticates from the kn_token cookie, not from ?token=', async () => {
    const http = await boot();
    const res = await http.get('/v1/asset').set('Cookie', `kn_lang=ru; kn_token=${GOOD_COOKIE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1' });
    expect((await http.get(`/v1/asset?token=${GOOD_QUERY}`)).status).toBe(401);
    expect((await http.get('/v1/asset').set('Cookie', 'kn_token=ks_bad')).status).toBe(401);
  });

  it('a @QueryTokenOk route ignores the cookie', async () => {
    const http = await boot();
    expect((await http.get('/v1/stream').set('Cookie', `kn_token=${GOOD_COOKIE}`)).status).toBe(401);
  });
});

/** `Class.handler` for every route in the app that carries `meta`, on itself or its class. */
async function routesWith(meta: string): Promise<string[]> {
  // Every controller in the app, so a new route can't opt in unnoticed.
  const src = join(import.meta.dirname, '../src');
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.controller.ts'));
  expect(files.length).toBeGreaterThan(20); // the walk found the app, not an empty dir
  const opted: string[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(src, file)).href)) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const cls = exported as { name: string; prototype: Record<string, unknown> };
      const classPath = Reflect.getMetadata('path', cls) as string | undefined;
      if (classPath === undefined) continue; // not a controller
      const classOpted = Reflect.getMetadata(meta, cls) === true;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        const handler = cls.prototype[name];
        if (typeof handler !== 'function' || Reflect.getMetadata('path', handler) === undefined) continue;
        if (classOpted || Reflect.getMetadata(meta, handler) === true) opted.push(`${cls.name}.${name}`);
      }
    }
  }
  return opted.sort();
}

// Each walk imports every controller module in the app: ~2.5 s alone, and past
// vitest's 5 s default when the full suite runs in parallel beside it.
describe('opt-in allowlists', () => {
  it('@QueryTokenOk is exactly the SSE stream', async () => {
    expect(await routesWith(QUERY_TOKEN_OK_META)).toEqual(['EventsController.events']);
  }, 30_000);

  it('@CookieTokenOk is exactly the <img> / <object> redirects', async () => {
    expect(await routesWith(COOKIE_TOKEN_OK_META)).toEqual([
      'AttachmentsController.content',
      'AvatarsController.projectAvatar',
      'AvatarsController.userAvatar',
      'ImportController.image',
    ]);
  }, 30_000);
});

describe('live WebSocket keeps its own ?token= path', () => {
  it('resolves the upgrade query token (it never passes through AuthGuard)', async () => {
    const resolve = vi.fn(async () => principal);
    const config = {
      get: (k: string) =>
        ({ LIVE_WS_ENABLED: true, LIVE_TRACKED_EVENTS: '', LIVE_WS_MAX_SUBSCRIPTIONS: 10 })[k],
    };
    const gw = new LiveGateway(config as never, { resolve, blocksUnverified: () => false } as never, {} as never, {} as never);
    const socket = { on: vi.fn(), close: vi.fn(), send: vi.fn() };
    await gw.handleConnection(socket as never, {
      url: `/v1/events/ws?token=${GOOD}`,
      headers: {},
    } as never);
    expect(resolve).toHaveBeenCalledWith(GOOD);
    expect(socket.close).not.toHaveBeenCalled();
  });
});

describe('redactUrl', () => {
  it('masks token values and keeps the key and the rest of the query', () => {
    expect(redactUrl('/v1/events?workspaceId=w1&token=kn_secret')).toBe('/v1/events?workspaceId=w1&token=[REDACTED]');
    expect(redactUrl('/v1/users/u/avatar?token=ks_abc&v=1')).toBe('/v1/users/u/avatar?token=[REDACTED]&v=1');
    expect(redactUrl('/x?TOKEN=a#frag')).toBe('/x?TOKEN=[REDACTED]#frag');
    expect(redactUrl('/x?access_token=a&api_key=b')).toBe('/x?access_token=[REDACTED]&api_key=[REDACTED]');
  });

  it('leaves look-alike keys and token-free URLs alone', () => {
    expect(redactUrl('/x?mytoken=a&tokenized=b')).toBe('/x?mytoken=a&tokenized=b');
    expect(redactUrl('/v1/documents/d1')).toBe('/v1/documents/d1');
    expect(redactUrl(undefined)).toBeUndefined();
  });
});
