import { afterEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuditService } from '../src/auth/audit.service.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { AuthPolicyService } from '../src/auth/auth-policy.service.js';
import { AuthRateLimitGuard } from '../src/auth/auth-rate-limit.guard.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import { SsoModule } from '../src/auth/sso/sso.module.js';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA, SCIM_PATH_PREFIX } from '../src/common/scim-error-body.js';
import { validateEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PublicRateLimiter } from '../src/public/public-rate-limit.js';
import { ScimModule } from '../src/scim/scim.module.js';

/**
 * #75 criterion 15: with SSO and SCIM off — `AUTH_MODE=none` whatever the
 * flags say, or `api-key` with the flags at their defaults — every route the
 * real SsoModule and ScimModule register answers 404 (SCIM's in RFC 7644's
 * shape), and the auth-policy route, deliberately unguarded because the
 * session age cap stands without SSO, still answers.
 *
 * The routes are read off the booted app, not listed by hand, so a new
 * controller in either module joins the matrix on its own. The global auth
 * guards are not part of this module: what is pinned is the modules' own
 * guards, which run whoever the caller is.
 */

const WS = '11111111-1111-4111-8111-111111111111';

/** The real env schema: only the vars with no default are given, the rest are what ships. */
const env = (over: Record<string, unknown> = {}) =>
  validateEnv({
    DATABASE_URL: 'postgresql://x', REDIS_URL: 'redis://x', S3_ENDPOINT: 'http://x', S3_ACCESS_KEY: 'x', S3_SECRET_KEY: 'x',
    S3_BUCKET: 'x', ARCADE_URL: 'http://x', ARCADE_DB: 'x', ARCADE_USER: 'x', ARCADE_PASSWORD: 'x',
    ...over,
  });

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(values: Record<string, unknown>) {
  const config = { get: (k: string) => values[k] };
  const prisma = {
    workspaceSettings: { findUnique: vi.fn(async () => null) },
    identityProvider: { findMany: vi.fn(async () => []) },
  };
  const audit = { record: vi.fn(async () => undefined) };
  // What the global AuthModule hands these modules in the real app.
  const authStandIn = {
    module: class AuthStandInModule {},
    global: true,
    providers: [
      { provide: ConfigService, useValue: config },
      { provide: AuditService, useValue: audit },
      { provide: SessionsService, useValue: {} },
      { provide: AuthFlowService, useValue: {} },
      { provide: PublicRateLimiter, useValue: { hit: vi.fn(async () => ({ allowed: true })) } },
      AuthRateLimitGuard,
      AuthPolicyService,
    ],
    exports: [ConfigService, AuditService, SessionsService, AuthFlowService, PublicRateLimiter, AuthRateLimitGuard, AuthPolicyService],
  };
  const moduleRef = await Test.createTestingModule({ imports: [authStandIn, SsoModule, ScimModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  return app;
}

interface Route {
  method: string;
  path: string;
}

/** Every route the booted app registered, with each `:param` filled in. */
function routesOf(nest: INestApplication): Route[] {
  const express = nest.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  const stack = (express.router ?? express._router)!.stack as { route?: { path: string; methods: Record<string, boolean> } }[];
  return stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((m) => m !== '_all')
          .map((method) => ({ method, path: layer.route!.path.replace(/:domain\b/, 'corp.example').replace(/:\w+/g, WS) }))
      : [],
  );
}

const send = (nest: INestApplication, { method, path }: Route) =>
  (request(nest.getHttpServer()) as unknown as Record<string, (p: string) => request.Test>)[method](path);

const isAuthPolicy = (r: Route) => r.path === `/v1/workspaces/${WS}/auth-policy`;

const OFF: [string, Record<string, unknown>][] = [
  ['AUTH_MODE=none, flags at their defaults', env()],
  ['AUTH_MODE=none, every flag on', env({ AUTH_SSO_ENABLED: 'true', AUTH_SCIM_ENABLED: 'true', AUTH_LDAP_ENABLED: 'true' })],
  ['AUTH_MODE=api-key, flags at their defaults', env({ AUTH_MODE: 'api-key' })],
];

describe('SSO and SCIM routes while disabled', () => {
  it('the defaults are off: SSO and SCIM both need a flag and AUTH_MODE=api-key', () => {
    expect(env()).toMatchObject({ AUTH_MODE: 'none', AUTH_SSO_ENABLED: false, AUTH_SCIM_ENABLED: false, AUTH_LDAP_ENABLED: false });
  });

  it.each(OFF)('%s: every route is a 404, SCIM in its own shape', async (_label, values) => {
    const nest = await boot(values);
    const routes = routesOf(nest);
    const paths = routes.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    // The matrix the issue names, so an empty route list cannot pass.
    for (const expected of [
      'GET /v1/auth/sso/providers',
      `GET /v1/auth/oidc/${WS}/start`,
      `POST /v1/auth/saml/${WS}/acs`,
      `POST /v1/auth/ldap/${WS}/login`,
      `GET /v1/workspaces/${WS}/identity-providers`,
      `POST /v1/workspaces/${WS}/sso-domains`,
      `GET /v1/workspaces/${WS}/group-mappings`,
      `GET /v1/workspaces/${WS}/scim`,
      `POST /v1/workspaces/${WS}/scim-tokens`,
      'GET /v1/scim/v2/Users',
      'POST /v1/scim/v2/Groups',
    ]) {
      expect(paths).toContain(expected);
    }

    for (const route of routes.filter((r) => !isAuthPolicy(r))) {
      const res = await send(nest, route);
      expect({ route: `${route.method} ${route.path}`, status: res.status }).toEqual({ route: `${route.method} ${route.path}`, status: 404 });
      if (route.path.startsWith(SCIM_PATH_PREFIX)) {
        expect(res.headers['content-type']).toContain(SCIM_CONTENT_TYPE);
        expect(res.body).toMatchObject({ schemas: [SCIM_ERROR_SCHEMA], status: '404' });
      } else {
        expect(res.body.message).toMatch(/error\.(sso|scim)\.disabled/);
      }
    }
  });

  it.each(OFF)('%s: the auth-policy route still answers', async (_label, values) => {
    const nest = await boot(values);
    const res = await request(nest.getHttpServer()).get(`/v1/workspaces/${WS}/auth-policy`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ceilings: { ssoEnabled: false } });
  });

  it('control: switched on under api-key, the same routes are there', async () => {
    const nest = await boot(env({ AUTH_MODE: 'api-key', AUTH_SSO_ENABLED: 'true', AUTH_SCIM_ENABLED: 'true' }));
    expect((await request(nest.getHttpServer()).get(`/v1/workspaces/${WS}/identity-providers`)).status).toBe(200);
    // No token: the SCIM guard now asks for one instead of hiding the route.
    expect((await request(nest.getHttpServer()).get('/v1/scim/v2/Users')).status).toBe(401);
  });
});
