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
import { CurrentPrincipal, QUERY_TOKEN_OK_META, QueryTokenOk, ReadKeyOk } from '../src/auth/access.decorator.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { LiveGateway } from '../src/events/live.gateway.js';

/**
 * `?token=` query auth is opt-in per route (#102). What is pinned:
 * - AuthGuard ignores a query token on any route without @QueryTokenOk, so a
 *   valid key in the URL of a read or write route is a 401;
 * - the opted-in routes still authenticate from ?token=, and a header still
 *   wins everywhere;
 * - the allowlist itself: exactly the SSE stream and the <img> redirects;
 * - the live WebSocket keeps its own ?token= path (not behind AuthGuard);
 * - token values are masked in logged URLs.
 */

const GOOD = 'kn_good_key';
const principal: Principal = { ...DEV_PRINCIPAL, mode: 'api-key', isAdmin: false, userId: 'u1' };

/** api-key mode: GOOD resolves, anything else (or nothing) is a 401. */
const tokenAuth = {
  resolve: vi.fn(async (token: string | undefined) => {
    if (token === GOOD) return principal;
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

  @Get('asset')
  @QueryTokenOk()
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
  ] as const)('%s %s with a valid key in ?token= and no header → 401', async (method, path) => {
    const http = await boot();
    const res = await http[method](`${path}?token=${GOOD}`);
    expect(res.status).toBe(401);
  });

  it('the same routes still accept the key as a Bearer header', async () => {
    const http = await boot();
    const res = await http.get('/v1/documents/d1/markdown').set('Authorization', `Bearer ${GOOD}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1' });
  });

  it('an opted-in route authenticates from ?token=', async () => {
    const http = await boot();
    const res = await http.get(`/v1/asset?token=${GOOD}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: 'u1' });
  });

  it('class-level @QueryTokenOk covers its handlers', async () => {
    const http = await boot();
    expect((await http.get(`/v1/opted-class?token=${GOOD}`)).status).toBe(200);
  });

  it('a Bearer header wins over ?token= on an opted-in route', async () => {
    const http = await boot();
    const res = await http.get('/v1/asset?token=kn_other').set('Authorization', `Bearer ${GOOD}`);
    expect(res.status).toBe(200);
  });

  it('an opted-in route with a bad query token is still a 401', async () => {
    const http = await boot();
    expect((await http.get('/v1/asset?token=kn_bad')).status).toBe(401);
  });
});

describe('@QueryTokenOk allowlist', () => {
  it('is exactly the SSE stream and the <img> redirects', async () => {
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
        const classOpted = Reflect.getMetadata(QUERY_TOKEN_OK_META, cls) === true;
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          if (name === 'constructor') continue;
          const handler = cls.prototype[name];
          if (typeof handler !== 'function' || Reflect.getMetadata('path', handler) === undefined) continue;
          if (classOpted || Reflect.getMetadata(QUERY_TOKEN_OK_META, handler) === true) {
            opted.push(`${cls.name}.${name}`);
          }
        }
      }
    }
    expect(opted.sort()).toEqual([
      'AttachmentsController.content',
      'AvatarsController.projectAvatar',
      'AvatarsController.userAvatar',
      'EventsController.events',
      'ImportController.image',
    ]);
  });
});

describe('live WebSocket keeps its own ?token= path', () => {
  it('resolves the upgrade query token (it never passes through AuthGuard)', async () => {
    const resolve = vi.fn(async () => principal);
    const config = {
      get: (k: string) =>
        ({ LIVE_WS_ENABLED: true, LIVE_TRACKED_EVENTS: '', LIVE_WS_MAX_SUBSCRIPTIONS: 10 })[k],
    };
    const gw = new LiveGateway(config as never, { resolve } as never, {} as never, {} as never);
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
