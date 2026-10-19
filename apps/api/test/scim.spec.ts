import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { ApiExceptionFilter } from '../src/common/api-exception.filter.js';
import { SCIM_CONTENT_TYPE } from '../src/common/scim-error-body.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuditService } from '../src/auth/audit.service.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import { RoleSyncService } from '../src/auth/sso/role-sync.service.js';
import { ScimController } from '../src/scim/scim.controller.js';
import { ScimService } from '../src/scim/scim.service.js';
import { ScimTokenGuard } from '../src/scim/scim-token.guard.js';
import { ScimTokensService } from '../src/scim/scim-tokens.service.js';

/**
 * SCIM 2.0 provisioning end to end over HTTP (#75 phase 5): the real
 * controller, token guard, service, role sync and error filter, over an
 * in-memory database. The request bodies are the shapes Entra ID and Okta
 * document and send — Entra's capitalised ops and `"False"` strings, Okta's
 * path-less replace and member removal by filter.
 *
 * What is pinned:
 * - create, `userName eq` lookup, paging, PUT and PATCH, and 201 + Location;
 * - deactivation removes the IdP-managed membership and revokes sessions, and
 *   disables the global account only under a domain this workspace verified;
 * - group membership drives roles through provider-less mappings, at once;
 * - a token sees only its own workspace; a revoked or foreign token is a 401;
 * - every error is `application/scim+json` in RFC 7644's shape.
 */

const WS_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WS_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const TOKEN_A = `kscim_${'a'.repeat(64)}`;
const TOKEN_B = `kscim_${'b'.repeat(64)}`;
const REVOKED = `kscim_${'c'.repeat(64)}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------- fake database

type Row = Record<string, any>;

const RELATIONS: Record<string, Record<string, { table: string; key: string; many?: boolean; fk?: string }>> = {
  scimUser: { user: { table: 'user', key: 'userId' } },
  scimGroupMember: { group: { table: 'scimGroup', key: 'groupId' }, user: { table: 'user', key: 'userId' } },
  scimGroup: { members: { table: 'scimGroupMember', key: 'id', many: true, fk: 'groupId' } },
  idpGroupMapping: { provider: { table: 'identityProvider', key: 'providerId' } },
};

const UNIQUE: Record<string, string[][]> = {
  user: [['email']],
  scimUser: [['workspaceId', 'userId'], ['workspaceId', 'userName'], ['workspaceId', 'externalId']],
  scimGroup: [['workspaceId', 'displayName']],
  scimGroupMember: [['groupId', 'userId']],
  scimToken: [['tokenHash']],
};

function fakeDb() {
  const tables: Record<string, Row[]> = {
    user: [], scimUser: [], scimGroup: [], scimGroupMember: [], scimToken: [], idpGroupMapping: [],
    workspaceMember: [], workspaceSettings: [], ssoDomain: [], identityProvider: [], session: [],
  };
  const related = (table: string, row: Row, name: string): Row | Row[] | null => {
    const rel = RELATIONS[table]?.[name];
    if (!rel) return null;
    if (rel.many) return tables[rel.table].filter((r) => r[rel.fk!] === row[rel.key]);
    return tables[rel.table].find((r) => r.id === row[rel.key]) ?? null;
  };
  const value = (v: unknown, cond: any): boolean => {
    if (cond === null) return v === null || v === undefined;
    if (cond instanceof Date || typeof cond !== 'object') return v === cond;
    if ('in' in cond) return cond.in.includes(v);
    if ('not' in cond) return !value(v, cond.not);
    if ('lt' in cond) return (v as Date) < cond.lt;
    if ('equals' in cond) return cond.mode === 'insensitive' ? String(v).toLowerCase() === String(cond.equals).toLowerCase() : v === cond.equals;
    throw new Error(`fake: unsupported condition ${JSON.stringify(cond)}`);
  };
  const matches = (table: string, row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([k, cond]) => {
      if (k === 'OR') return (cond as Row[]).some((w) => matches(table, row, w));
      const rel = RELATIONS[table]?.[k];
      if (rel && !rel.many) {
        const target = related(table, row, k) as Row | null;
        return !!target && matches(rel.table, target, cond);
      }
      if (/^\w+_\w+$/.test(k) && typeof cond === 'object') return matches(table, row, cond); // compound unique key
      return value(row[k], cond);
    });
  const shape = (table: string, row: Row, include?: Row): Row => {
    if (!include) return { ...row };
    const out: Row = { ...row };
    for (const [name, spec] of Object.entries(include)) {
      if (name === '_count') {
        out._count = Object.fromEntries(Object.keys(spec.select).map((k) => [k, (related(table, row, k) as Row[]).length]));
        continue;
      }
      const rel = RELATIONS[table][name];
      const target = related(table, row, name);
      const inner = typeof spec === 'object' ? spec.include : undefined;
      out[name] = Array.isArray(target) ? target.map((t) => shape(rel.table, t, inner)) : target && shape(rel.table, target, inner);
    }
    return out;
  };
  const unique = (table: string, row: Row, except?: Row) => {
    for (const cols of UNIQUE[table] ?? []) {
      if (cols.some((c) => row[c] === null || row[c] === undefined)) continue;
      if (tables[table].some((r) => r !== except && cols.every((c) => r[c] === row[c]))) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'fake' });
      }
    }
  };
  const defaults: Record<string, () => Row> = {
    user: () => ({ id: randomUUID(), createdAt: new Date(), disabledAt: null, emailVerifiedAt: null }),
    scimUser: () => ({ externalId: null, userName: null, active: true, raw: {}, updatedAt: new Date() }),
    scimGroup: () => ({ id: randomUUID(), externalId: null, updatedAt: new Date() }),
    idpGroupMapping: () => ({ id: randomUUID(), trustedOperator: false, createdAt: new Date() }),
    workspaceMember: () => ({ trustedOperator: false, source: 'manual', createdAt: new Date() }),
    scimToken: () => ({ id: randomUUID(), lastUsedAt: null, revokedAt: null, createdAt: new Date() }),
  };
  const model = (table: string) => {
    const all = (where?: Row) => tables[table].filter((r) => matches(table, r, where));
    const insert = (data: Row) => {
      const row = { ...(defaults[table]?.() ?? {}), ...data };
      unique(table, row);
      tables[table].push(row);
      return row;
    };
    const patch = (row: Row, data: Row) => {
      const next = { ...row, ...data, ...('updatedAt' in row ? { updatedAt: new Date() } : {}) };
      unique(table, next, row);
      Object.assign(row, next);
      return row;
    };
    return {
      findMany: vi.fn(async (a: Row = {}) => {
        let rows = all(a.where);
        if (a.orderBy) {
          const keys = (Array.isArray(a.orderBy) ? a.orderBy : [a.orderBy]).map((o: Row) => Object.keys(o)[0]);
          rows = [...rows].sort((x, y) => keys.map((k: string) => String(x[k]).localeCompare(String(y[k]))).find((c: number) => c) ?? 0);
        }
        rows = rows.slice(a.skip ?? 0, a.take === undefined ? undefined : (a.skip ?? 0) + a.take);
        return rows.map((r) => shape(table, r, a.include));
      }),
      findFirst: vi.fn(async (a: Row = {}) => {
        const r = all(a.where)[0];
        return r ? shape(table, r, a.include) : null;
      }),
      findUnique: vi.fn(async (a: Row) => {
        const r = all(a.where)[0];
        return r ? shape(table, r, a.include) : null;
      }),
      count: vi.fn(async (a: Row = {}) => all(a.where).length),
      create: vi.fn(async (a: Row) => ({ ...insert(a.data) })),
      createMany: vi.fn(async (a: Row) => {
        let count = 0;
        for (const d of a.data as Row[]) {
          try {
            insert(d);
            count++;
          } catch (e) {
            if (!a.skipDuplicates) throw e;
          }
        }
        return { count };
      }),
      update: vi.fn(async (a: Row) => {
        const r = all(a.where)[0];
        if (!r) throw new Error(`fake: ${table}.update found nothing`);
        return { ...patch(r, a.data) };
      }),
      updateMany: vi.fn(async (a: Row) => {
        const rows = all(a.where);
        rows.forEach((r) => patch(r, a.data));
        return { count: rows.length };
      }),
      upsert: vi.fn(async (a: Row) => {
        const r = all(a.where)[0];
        return r ? { ...patch(r, a.update) } : { ...insert(a.create) };
      }),
      delete: vi.fn(async (a: Row) => {
        const r = all(a.where)[0];
        tables[table].splice(tables[table].indexOf(r), 1);
        if (table === 'scimGroup') tables.scimGroupMember = tables.scimGroupMember.filter((m) => m.groupId !== r.id);
        return r;
      }),
      deleteMany: vi.fn(async (a: Row = {}) => {
        const rows = all(a.where);
        tables[table] = tables[table].filter((r) => !rows.includes(r));
        return { count: rows.length };
      }),
    };
  };
  const members = () => tables.workspaceMember;
  const find = (ws: string, user: string) => members().find((m) => m.workspaceId === ws && m.userId === user);
  const otherAdmin = (ws: string, user: string) => members().some((m) => m.workspaceId === ws && m.role === 'admin' && m.userId !== user);
  const prisma = {
    ...Object.fromEntries(Object.keys(tables).map((t) => [t, model(t)])),
    userGroupMember: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    accessGrant: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    // The two guarded statements of membership-guards.ts, by bound value order.
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('UPDATE workspace_members')) {
        const [role, ws, user, sources] = v as [string, string, string, string[] | null];
        const row = find(ws, user);
        if (!row || (sources && !sources.includes(row.source))) return 0;
        if (row.role === 'admin' && role !== 'admin' && !otherAdmin(ws, user)) return 0;
        row.role = role;
        return 1;
      }
      if (sql.includes('DELETE FROM workspace_members')) {
        const [ws, user, sources] = v as [string, string, string[] | null];
        const row = find(ws, user);
        if (!row || (sources && !sources.includes(row.source))) return 0;
        if (row.role === 'admin' && !otherAdmin(ws, user)) return 0;
        tables.workspaceMember = members().filter((m) => m !== row);
        return 1;
      }
      throw new Error(`fake: unexpected SQL ${sql}`);
    }),
  };
  return { tables, prisma };
}

// ---------------------------------------------------------------- the app

const config = {
  get: (k: string) =>
    ({ AUTH_SCIM_ENABLED: true, AUTH_MODE: 'api-key', AUTH_SCIM_MAX_PAGE: 2, API_PUBLIC_URL: 'https://kb.example' })[k],
};

let app: INestApplication;
let db: ReturnType<typeof fakeDb>;
let audit: { record: ReturnType<typeof vi.fn> };
let sessions: { revokeAllForUser: ReturnType<typeof vi.fn> };
let tokens: ScimTokensService;

beforeEach(async () => {
  await app?.close();
  db = fakeDb();
  audit = { record: vi.fn(async () => undefined) };
  sessions = { revokeAllForUser: vi.fn(async () => 1) };
  db.tables.scimToken.push(
    { id: randomUUID(), workspaceId: WS_A, name: 'Entra', tokenHash: sha(TOKEN_A), prefix: 'kscim_aaaaaaaa', lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    { id: randomUUID(), workspaceId: WS_B, name: 'Okta', tokenHash: sha(TOKEN_B), prefix: 'kscim_bbbbbbbb', lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    { id: randomUUID(), workspaceId: WS_A, name: 'Old', tokenHash: sha(REVOKED), prefix: 'kscim_cccccccc', lastUsedAt: null, revokedAt: new Date(), createdAt: new Date() },
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [ScimController],
    providers: [
      ScimService,
      ScimTokenGuard,
      RoleSyncService,
      ScimTokensService,
      { provide: PrismaService, useValue: db.prisma },
      { provide: AuditService, useValue: audit },
      { provide: SessionsService, useValue: sessions },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  const nest = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  nest.useBodyParser('json', { type: ['application/json', SCIM_CONTENT_TYPE] });
  nest.useGlobalFilters(new ApiExceptionFilter());
  await nest.init();
  app = nest;
  tokens = moduleRef.get(ScimTokensService);
});

afterAll(async () => {
  await app?.close();
});

const as = (token: string) => ({
  get: (path: string) => request(app.getHttpServer()).get(`/v1/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
  post: (path: string, body: object) =>
    request(app.getHttpServer()).post(`/v1/scim/v2${path}`).set('Authorization', `Bearer ${token}`).set('Content-Type', SCIM_CONTENT_TYPE).send(JSON.stringify(body)),
  put: (path: string, body: object) =>
    request(app.getHttpServer()).put(`/v1/scim/v2${path}`).set('Authorization', `Bearer ${token}`).set('Content-Type', SCIM_CONTENT_TYPE).send(JSON.stringify(body)),
  patch: (path: string, body: object) =>
    request(app.getHttpServer()).patch(`/v1/scim/v2${path}`).set('Authorization', `Bearer ${token}`).set('Content-Type', SCIM_CONTENT_TYPE).send(JSON.stringify(body)),
  delete: (path: string) => request(app.getHttpServer()).delete(`/v1/scim/v2${path}`).set('Authorization', `Bearer ${token}`),
});
const entra = as(TOKEN_A);
const okta = as(TOKEN_B);

const actions = () => (audit.record.mock.calls as unknown as Row[][]).map((c) => c[0].action);
const member = (ws: string, userId: string) => db.tables.workspaceMember.find((m) => m.workspaceId === ws && m.userId === userId);

// ------------------------------------------------------------- fixtures

/** Entra ID's create, per its SCIM provisioning reference: UPN as userName, the mail as a work email. */
const ENTRA_CREATE = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
  externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef',
  userName: 'Ada@corp.onmicrosoft.com',
  active: true,
  emails: [{ primary: true, type: 'work', value: 'Ada@Corp.Example' }],
  name: { formatted: 'Ada Lovelace', familyName: 'Lovelace', givenName: 'Ada' },
  'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Analytics' },
};
/** Entra's deactivation: a capitalised op and the boolean as a string. */
const ENTRA_DISABLE = {
  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
};
/** Okta's create: login as userName, password omitted by the app's settings. */
const OKTA_CREATE = (login: string) => ({
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  userName: login,
  name: { givenName: login.split('@')[0], familyName: 'Test' },
  emails: [{ primary: true, value: login, type: 'work' }],
  displayName: `${login.split('@')[0]} Test`,
  locale: 'en-US',
  externalId: `00u-${login}`,
  groups: [],
  password: 'never-stored',
  active: true,
});

async function createAda(): Promise<string> {
  const res = await entra.post('/Users', ENTRA_CREATE);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// ------------------------------------------------------------------ specs

describe('SCIM Users', () => {
  it('creates an SSO-only account and a membership, answering 201 with Location in SCIM JSON', async () => {
    const res = await entra.post('/Users', ENTRA_CREATE);
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toContain(SCIM_CONTENT_TYPE);
    expect(res.headers.location).toBe(`https://kb.example/v1/scim/v2/Users/${res.body.id}`);
    expect(res.body).toMatchObject({
      schemas: expect.arrayContaining(['urn:ietf:params:scim:schemas:core:2.0:User']),
      userName: 'ada@corp.onmicrosoft.com',
      externalId: ENTRA_CREATE.externalId,
      active: true,
      displayName: 'Ada Lovelace',
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Analytics' },
    });
    const user = db.tables.user.find((u) => u.id === res.body.id)!;
    expect(user).toMatchObject({ email: 'ada@corp.example', passwordHash: null, emailVerifiedAt: null });
    expect(member(WS_A, user.id)).toMatchObject({ role: 'viewer', source: 'scim' });
    expect(actions()).toEqual(expect.arrayContaining(['scim.user_created', 'role_sync.applied']));
  });

  it('never stores a password the client sends', async () => {
    const res = await okta.post('/Users', OKTA_CREATE('bob@other.example'));
    expect(res.status).toBe(201);
    const row = db.tables.scimUser.find((u) => u.userId === res.body.id)!;
    expect(JSON.stringify(row.raw)).not.toContain('never-stored');
    expect(res.body).not.toHaveProperty('password');
  });

  it('links an existing account by address instead of creating a second one', async () => {
    db.tables.user.push({ id: randomUUID(), email: 'ada@corp.example', displayName: 'Ada (manual)', createdAt: new Date(), disabledAt: null });
    const id = await createAda();
    expect(db.tables.user).toHaveLength(1);
    expect(db.tables.user[0]).toMatchObject({ id, displayName: 'Ada (manual)' });
  });

  it('finds a user by userName eq, case-insensitively, and answers an empty list for a stranger', async () => {
    const id = await createAda();
    const hit = await entra.get('/Users').query({ filter: 'userName eq "ADA@corp.onmicrosoft.com"' });
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 1, startIndex: 1 });
    expect(hit.body.Resources[0].id).toBe(id);
    // Entra's "test connection" probe.
    const miss = await entra.get('/Users').query({ filter: `userName eq "${randomUUID()}"` });
    expect(miss.body).toMatchObject({ totalResults: 0, Resources: [] });
    const byMail = await entra.get('/Users').query({ filter: 'emails[type eq "work"].value eq "ada@corp.example"' });
    expect(byMail.body.totalResults).toBe(1);
  });

  it('pages with startIndex and count, capped by AUTH_SCIM_MAX_PAGE', async () => {
    for (const n of [1, 2, 3]) await okta.post('/Users', OKTA_CREATE(`u${n}@other.example`));
    const first = await okta.get('/Users').query({ startIndex: 1, count: 50 });
    expect(first.body).toMatchObject({ totalResults: 3, startIndex: 1, itemsPerPage: 2 });
    const second = await okta.get('/Users').query({ startIndex: 3 });
    expect(second.body).toMatchObject({ totalResults: 3, startIndex: 3, itemsPerPage: 1 });
    const total = await okta.get('/Users').query({ count: 0 });
    expect(total.body).toMatchObject({ totalResults: 3, itemsPerPage: 0 });
  });

  it('answers a duplicate userName with 409 uniqueness', async () => {
    await createAda();
    const res = await entra.post('/Users', ENTRA_CREATE);
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain(SCIM_CONTENT_TYPE);
    expect(res.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '409', scimType: 'uniqueness' });
  });

  it('PATCH active "False" removes the membership and revokes sessions, without disabling an unverified domain', async () => {
    const id = await createAda();
    const res = await entra.patch(`/Users/${id}`, ENTRA_DISABLE);
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(member(WS_A, id)).toBeUndefined();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(id);
    expect(db.tables.user.find((u) => u.id === id)!.disabledAt).toBeNull();
    expect(actions()).toContain('scim.user_deactivated');

    // Re-activating restores the membership.
    await entra.patch(`/Users/${id}`, { Operations: [{ op: 'replace', value: { active: true } }] });
    expect(member(WS_A, id)).toMatchObject({ source: 'scim' });
  });

  it('disables the global account only when this workspace verified the domain, and re-enables it', async () => {
    db.tables.ssoDomain.push({ domain: 'corp.example', workspaceId: WS_A, verifiedAt: new Date() });
    const id = await createAda();
    expect(db.tables.user.find((u) => u.id === id)!.emailVerifiedAt).toBeInstanceOf(Date);
    await entra.patch(`/Users/${id}`, ENTRA_DISABLE);
    expect(db.tables.user.find((u) => u.id === id)!.disabledAt).toBeInstanceOf(Date);
    await entra.patch(`/Users/${id}`, { Operations: [{ op: 'Replace', path: 'active', value: 'True' }] });
    expect(db.tables.user.find((u) => u.id === id)!.disabledAt).toBeNull();

    // Another workspace's verification is no authority here.
    db.tables.ssoDomain[0].workspaceId = WS_B;
    await entra.patch(`/Users/${id}`, ENTRA_DISABLE);
    expect(db.tables.user.find((u) => u.id === id)!.disabledAt).toBeNull();
  });

  it('rewrites the global name and address only under a verified domain', async () => {
    const id = await createAda();
    const rename = { Operations: [{ op: 'Replace', path: 'displayName', value: 'Ada King' }, { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ada.king@corp.example' }] };
    const res = await entra.patch(`/Users/${id}`, rename);
    // The client sees what it said; the account is untouched.
    expect(res.body).toMatchObject({ displayName: 'Ada King', emails: [expect.objectContaining({ value: 'ada.king@corp.example' })] });
    expect(db.tables.user.find((u) => u.id === id)).toMatchObject({ email: 'ada@corp.example', displayName: 'Ada Lovelace' });

    db.tables.ssoDomain.push({ domain: 'corp.example', workspaceId: WS_A, verifiedAt: new Date() });
    await entra.patch(`/Users/${id}`, rename);
    expect(db.tables.user.find((u) => u.id === id)).toMatchObject({ email: 'ada.king@corp.example', displayName: 'Ada King' });
  });

  it('PUT replaces the document (Okta)', async () => {
    const created = await okta.post('/Users', OKTA_CREATE('carol@other.example'));
    const res = await okta.put(`/Users/${created.body.id}`, { ...OKTA_CREATE('carol@other.example'), displayName: 'Carol T.', active: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ displayName: 'Carol T.', active: false });
    expect(member(WS_B, created.body.id)).toBeUndefined();
  });

  it('DELETE removes the membership and the record, and the id is then a 404', async () => {
    const id = await createAda();
    expect((await entra.delete(`/Users/${id}`)).status).toBe(204);
    expect(member(WS_A, id)).toBeUndefined();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(id);
    expect(db.tables.user).toHaveLength(1);
    const gone = await entra.get(`/Users/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ status: '404', schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'] });
    expect(actions()).toContain('scim.user_deleted');
  });

  it('leaves a manual membership alone, deactivation included', async () => {
    const id = await createAda();
    member(WS_A, id)!.source = 'manual';
    member(WS_A, id)!.role = 'editor';
    await entra.patch(`/Users/${id}`, ENTRA_DISABLE);
    expect(member(WS_A, id)).toMatchObject({ role: 'editor', source: 'manual' });
  });

  it('takes over a membership a sign-in created, so deactivation reaches it', async () => {
    const existing = { id: randomUUID(), email: 'ada@corp.example', displayName: 'Ada', createdAt: new Date(), disabledAt: null };
    db.tables.user.push(existing);
    db.tables.workspaceMember.push({ workspaceId: WS_A, userId: existing.id, role: 'editor', trustedOperator: false, source: 'jit' });
    await createAda();
    expect(member(WS_A, existing.id)).toMatchObject({ role: 'viewer', source: 'scim' });
    await entra.patch(`/Users/${existing.id}`, ENTRA_DISABLE);
    expect(member(WS_A, existing.id)).toBeUndefined();
  });

  it('refuses an unsupported filter with 400 invalidFilter', async () => {
    const res = await entra.get('/Users').query({ filter: 'userName sw "ada"' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: '400', scimType: 'invalidFilter' });
  });
});

describe('SCIM Groups', () => {
  it('creates a group, and membership drives the role through a SCIM mapping at once', async () => {
    const ada = await createAda();
    const res = await entra.post('/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Knowledge Editors', members: [{ value: ada }, { value: randomUUID() }] });
    expect(res.status).toBe(201);
    expect(res.body.members).toEqual([expect.objectContaining({ value: ada })]);
    const group = res.body.id as string;

    db.tables.idpGroupMapping.push({ id: randomUUID(), workspaceId: WS_A, providerId: null, externalGroup: group, role: 'editor', trustedOperator: true });
    // Okta's removal by filter, then Entra's add by value list.
    await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'remove', path: `members[value eq "${ada}"]` }] });
    expect(member(WS_A, ada)).toMatchObject({ role: 'viewer', trustedOperator: false });
    await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: ada }] }] });
    expect(member(WS_A, ada)).toMatchObject({ role: 'editor', trustedOperator: true, source: 'scim' });

    // Deleting the group drops its mapping and the role it gave.
    expect((await entra.delete(`/Groups/${group}`)).status).toBe(204);
    expect(db.tables.idpGroupMapping).toHaveLength(0);
    expect(member(WS_A, ada)).toMatchObject({ role: 'viewer' });
    expect(actions()).toEqual(expect.arrayContaining(['scim.group_created', 'scim.group_updated', 'scim.group_deleted']));
  });

  it('finds a group by displayName and leaves members out when asked (Entra)', async () => {
    const ada = await createAda();
    await entra.post('/Groups', { displayName: 'Readers', members: [{ value: ada }] });
    const res = await entra.get('/Groups').query({ filter: 'displayName eq "readers"', excludedAttributes: 'members' });
    expect(res.body.totalResults).toBe(1);
    expect(res.body.Resources[0]).not.toHaveProperty('members');
    expect((await entra.get(`/Users/${ada}`)).body.groups).toEqual([expect.objectContaining({ display: 'Readers' })]);
  });

  it('answers a duplicate displayName with 409', async () => {
    await entra.post('/Groups', { displayName: 'Readers' });
    const res = await entra.post('/Groups', { displayName: 'Readers' });
    expect(res.status).toBe(409);
    expect(res.body.scimType).toBe('uniqueness');
  });

  it('the default role decides without a mapped group, and none grants nothing', async () => {
    db.tables.workspaceSettings.push({ workspaceId: WS_A, scimDefaultRole: 'none' });
    const ada = await createAda();
    expect(member(WS_A, ada)).toBeUndefined();
    await tokens.putSettings(WS_A, 'editor', { userId: 'admin' } as never);
    expect(member(WS_A, ada)).toMatchObject({ role: 'editor', source: 'scim' });
  });
});

describe('SCIM role sync safety (#75 criterion 8)', () => {
  const blockedRows = () => (audit.record.mock.calls as unknown as Row[][]).map((c) => c[0]).filter((e) => e.action === 'role_sync.blocked_last_admin');

  /** A SCIM group with a provider-less mapping to `role`, and Ada provisioned into it. */
  async function mappedGroup(role: string): Promise<{ ada: string; group: string }> {
    const ada = await createAda();
    const res = await entra.post('/Groups', { displayName: `Knowledge ${role}s` });
    const group = res.body.id as string;
    db.tables.idpGroupMapping.push({ id: randomUUID(), workspaceId: WS_A, providerId: null, externalGroup: group, role, trustedOperator: false });
    await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: ada }] }] });
    return { ada, group };
  }

  describe('the sole admin, provisioned through an admin mapping, is never demoted or removed', () => {
    it.each([
      ['removed from the group', (ada: string, group: string) => entra.patch(`/Groups/${group}`, { Operations: [{ op: 'remove', path: `members[value eq "${ada}"]` }] })],
      ['the group deleted', (_ada: string, group: string) => entra.delete(`/Groups/${group}`)],
      ['deactivated', (ada: string) => entra.patch(`/Users/${ada}`, ENTRA_DISABLE)],
    ])('%s: the role stays and one blocked_last_admin row is written', async (_label, act) => {
      const { ada, group } = await mappedGroup('admin');
      expect(member(WS_A, ada)).toMatchObject({ role: 'admin', source: 'scim' });
      expect(db.tables.workspaceMember.filter((m) => m.workspaceId === WS_A && m.role === 'admin')).toHaveLength(1);
      expect(blockedRows()).toHaveLength(0);

      expect((await act(ada, group)).status).toBeLessThan(300);
      expect(member(WS_A, ada)).toMatchObject({ role: 'admin', source: 'scim' });
      expect(blockedRows()).toEqual([
        expect.objectContaining({ workspaceId: WS_A, target: ada, ok: false, error: 'last-admin', params: expect.objectContaining({ via: 'scim' }) }),
      ]);
    });
  });

  describe('a manual membership is immune to SCIM group changes', () => {
    async function manualInMappedGroup() {
      const { ada, group } = await mappedGroup('admin');
      // A second admin, so nothing below is the last-admin rule at work.
      db.tables.workspaceMember.push({ workspaceId: WS_A, userId: randomUUID(), role: 'admin', trustedOperator: false, source: 'manual', createdAt: new Date() });
      await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'remove', path: `members[value eq "${ada}"]` }] });
      // An admin takes the row over by hand.
      Object.assign(member(WS_A, ada)!, { role: 'editor', source: 'manual' });
      return { ada, group };
    }

    it('group PATCH add and remove leave role and source unchanged', async () => {
      const { ada, group } = await manualInMappedGroup();
      await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: ada }] }] });
      expect(db.tables.scimGroupMember.some((m) => m.groupId === group && m.userId === ada)).toBe(true);
      expect(member(WS_A, ada)).toMatchObject({ role: 'editor', source: 'manual' });
      await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'remove', path: `members[value eq "${ada}"]` }] });
      expect(member(WS_A, ada)).toMatchObject({ role: 'editor', source: 'manual' });
    });

    it('group DELETE leaves role and source unchanged', async () => {
      const { ada, group } = await manualInMappedGroup();
      await entra.patch(`/Groups/${group}`, { Operations: [{ op: 'Add', path: 'members', value: [{ value: ada }] }] });
      expect((await entra.delete(`/Groups/${group}`)).status).toBe(204);
      expect(member(WS_A, ada)).toMatchObject({ role: 'editor', source: 'manual' });
    });
  });
});

describe('SCIM tokens and isolation', () => {
  it("never shows or changes another workspace's users", async () => {
    const ada = await createAda();
    expect((await okta.get(`/Users/${ada}`)).status).toBe(404);
    expect((await okta.patch(`/Users/${ada}`, ENTRA_DISABLE)).status).toBe(404);
    expect((await okta.delete(`/Users/${ada}`)).status).toBe(404);
    expect((await okta.get('/Users')).body.totalResults).toBe(0);
    expect(member(WS_A, ada)).toBeDefined();
  });

  it.each([
    ['a revoked token', REVOKED],
    ['an unknown token', `kscim_${'d'.repeat(64)}`],
    ['a session token', 'ks_session'],
  ])('answers %s with 401 in SCIM JSON', async (_, token) => {
    const res = await as(token).get('/Users');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain(SCIM_CONTENT_TYPE);
    expect(res.body).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
  });

  it('serves the discovery documents', async () => {
    const spc = await entra.get('/ServiceProviderConfig');
    expect(spc.body).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 2 } });
    expect((await entra.get('/ResourceTypes')).body.Resources.map((r: Row) => r.id)).toEqual(['User', 'Group']);
    expect((await entra.get('/Schemas')).body.totalResults).toBe(2);
  });

  it('mints a token whose secret is shown once and stored only as a hash', async () => {
    const created = await tokens.create(WS_A, 'Keycloak', { userId: 'admin' } as never);
    expect(created.secret).toMatch(/^kscim_[0-9a-f]{64}$/);
    expect(JSON.stringify(db.tables.scimToken)).not.toContain(created.secret);
    expect((await as(created.secret).get('/Users')).status).toBe(200);
    await tokens.revoke(WS_A, created.token.id, { userId: 'admin' } as never);
    expect((await as(created.secret).get('/Users')).status).toBe(401);
    expect(actions()).toEqual(expect.arrayContaining(['scim.token_created', 'scim.token_revoked']));
  });
});
