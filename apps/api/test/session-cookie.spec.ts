import { describe, expect, it, vi, afterEach } from 'vitest';
import 'reflect-metadata';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard.js';
import { AuthFlowController } from '../src/auth/auth-flow.controller.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { UrlTicketsService } from '../src/auth/url-tickets.service.js';
import { PublicRateLimiter } from '../src/public/public-rate-limit.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';

/**
 * #650: the browser's session is an HttpOnly cookie the API sets. Pinned:
 * - a sign-in answers `Set-Cookie: kn_token=…; HttpOnly; SameSite=Lax`, plus
 *   `Secure` when WEB_BASE_URL is https, and its JSON body has no token;
 * - logout clears the cookie;
 * - the one-release migration turns a bearer `ks_` session into the cookie,
 *   and nothing else (an API key, a dead session).
 */

const SESSION = 'ks_live_session';
const EXPIRES = '2030-01-01T00:00:00.000Z';
const principal: Principal = { ...DEV_PRINCIPAL, mode: 'session', isAdmin: false, userId: 'u1', sessionId: 's1' };

describe('session cookie (#650)', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  async function boot(webBaseUrl: string) {
    const flow = {
      login: vi.fn(async () => ({ token: SESSION, expiresAt: EXPIRES, me: { userId: 'u1' } })),
      logout: vi.fn(async () => undefined),
    };
    const mod = await Test.createTestingModule({
      controllers: [AuthFlowController],
      providers: [
        { provide: AuthFlowService, useValue: flow },
        {
          provide: TokenAuthService,
          useValue: {
            blocksUnverified: () => false,
            resolve: async (t?: string) => {
              if (t === SESSION || t === 'kn_key') return principal;
              throw new UnauthorizedException('no');
            },
            resolveSessionCookie: async (t: string) => {
              if (t === SESSION) return principal;
              throw new UnauthorizedException('no');
            },
          },
        },
        { provide: UrlTicketsService, useValue: {} },
        {
          provide: SessionsService,
          useValue: { resolve: async (t: string) => (t === SESSION ? { expiresAt: new Date(EXPIRES) } : null) },
        },
        { provide: ConfigService, useValue: { get: () => webBaseUrl } },
        { provide: PublicRateLimiter, useValue: { hit: async () => true } },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    return request(app.getHttpServer());
  }

  const cookieOf = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).join('\n');

  it('login sets an HttpOnly, Secure, SameSite=Lax cookie and leaves the token out of the body', async () => {
    const http = await boot('https://knowledge.example');
    const res = await http.post('/v1/auth/login').send({ email: 'a@b.c', password: 'secret-pass-1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expiresAt: EXPIRES, me: { userId: 'u1' } });
    expect(JSON.stringify(res.body)).not.toContain(SESSION);
    const cookie = cookieOf(res);
    expect(cookie).toContain(`kn_token=${SESSION}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toContain('Expires=Tue, 01 Jan 2030');
  });

  it('over plain-http dev the cookie is not Secure', async () => {
    const http = await boot('http://localhost:5173');
    const res = await http.post('/v1/auth/login').send({ email: 'a@b.c', password: 'secret-pass-1' });
    expect(cookieOf(res)).not.toMatch(/Secure/);
  });

  it('logout clears the cookie', async () => {
    const http = await boot('https://knowledge.example');
    const res = await http.post('/v1/auth/logout').set('Cookie', `kn_token=${SESSION}`).set('X-Requested-With', 'knowledge');
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toMatch(/kn_token=;.*Expires=Thu, 01 Jan 1970/);
  });

  it('migration: a bearer ks_ session comes back as the cookie; an API key does not', async () => {
    const http = await boot('https://knowledge.example');
    const ok = await http.post('/v1/auth/session-cookie').set('Authorization', `Bearer ${SESSION}`);
    expect(ok.body).toEqual({ ok: true });
    expect(cookieOf(ok)).toContain(`kn_token=${SESSION}`);
    const key = await http.post('/v1/auth/session-cookie').set('Authorization', 'Bearer kn_key');
    expect(key.body).toEqual({ ok: false });
    expect(cookieOf(key)).toBe('');
  });
});
