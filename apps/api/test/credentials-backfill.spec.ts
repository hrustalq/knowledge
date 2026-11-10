import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { credentialSiteFor } from '@knowledge/contracts';
import { decryptSecret, encryptSecret } from '../src/ai/secret-box.js';
import { backfillCredentials } from '../src/connectors/credentials.backfill.js';

/** Per-user credentials (#857, phase 1): what the boot backfill merges, and what it never does. */
const key = randomBytes(32);
const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const ANN = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';

type Row = Record<string, unknown> & { id: string; createdAt: Date; updatedAt: Date };

const matches = (row: Row, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([k, v]) =>
    v && typeof v === 'object' && 'not' in v ? row[k] !== (v as { not: unknown }).not : (row[k] ?? null) === v,
  );

/** Just enough Prisma for the backfill, over arrays. Every write moves the clock, as `@updatedAt` does. */
function fakeDb(seed: { connections?: Row[]; githubTokens?: Row[]; figmaGrants?: Row[] }) {
  let clock = Date.now();
  const tick = () => new Date((clock += 1000));
  const credentials: Row[] = [];
  const connections = seed.connections ?? [];
  const byAge = (rows: Row[]) => [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const db = {
    credentials,
    connections,
    credential: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => byAge(credentials).find((c) => matches(c, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => byAge(credentials).filter((c) => matches(c, where)),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const now = tick();
        const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...data } as Row;
        credentials.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(credentials.find((c) => c.id === where.id)!, data, { updatedAt: tick() }),
    },
    connection: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        byAge(connections)
          .filter((c) => matches(c, where))
          .map((c) => ({ ...c, credentialRow: credentials.find((r) => r.id === c.credentialId) ?? null })),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
        Object.assign(connections.find((c) => c.id === where.id)!, data, { updatedAt: tick() }),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = connections.filter((c) => matches(c, where));
        hit.forEach((c) => Object.assign(c, data, { updatedAt: tick() }));
        return { count: hit.length };
      },
    },
    githubUserToken: { findMany: async () => seed.githubTokens ?? [] },
    figmaOauthGrant: { findMany: async () => seed.figmaGrants ?? [] },
  };
  return db;
}

const past = new Date('2026-01-01T00:00:00Z');
function tokenConnection(over: Record<string, unknown> & { token: string }): Row {
  const { token, ...rest } = over;
  return {
    id: randomUUID(),
    workspaceId: WS_A,
    provider: 'gitlab',
    method: 'token',
    site: 'https://gitlab.com',
    accountId: null,
    accountLabel: null,
    accountAvatarUrl: null,
    credential: encryptSecret(token, key),
    credentialHint: `…${token.slice(-4)}`,
    externalRef: null,
    credentialId: null,
    createdBy: ANN,
    createdAt: past,
    updatedAt: past,
    ...rest,
  };
}
const run = (db: ReturnType<typeof fakeDb>) => backfillCredentials(db as never, key);
const secretOf = (db: ReturnType<typeof fakeDb>, connectionId: string) => {
  const c = db.connections.find((r) => r.id === connectionId)!;
  return decryptSecret(db.credentials.find((r) => r.id === c.credentialId)!.secret as string, key);
};

describe('backfillCredentials: pasted tokens', () => {
  it('gives one owner one credential for one secret, across workspaces', async () => {
    const a = tokenConnection({ token: 'glpat-same' });
    const b = tokenConnection({ token: 'glpat-same', workspaceId: WS_B });
    const db = fakeDb({ connections: [a, b] });
    expect(await run(db)).toBe(2);
    expect(db.credentials).toHaveLength(1);
    expect(a.credentialId).toBe(db.credentials[0].id);
    expect(b.credentialId).toBe(db.credentials[0].id);
    expect(db.credentials[0]).toMatchObject({ userId: ANN, provider: 'gitlab', method: 'token', site: 'https://gitlab.com' });
  });

  it('never merges two secrets for one account, two owners, or two GitLab instances', async () => {
    const db = fakeDb({
      connections: [
        tokenConnection({ token: 'glpat-org-a', accountId: '7' }),
        tokenConnection({ token: 'glpat-org-b', accountId: '7', workspaceId: WS_B }),
        tokenConnection({ token: 'glpat-org-a', createdBy: BOB, workspaceId: WS_B }),
        tokenConnection({ token: 'glpat-org-a', site: 'https://gitlab.acme.io' }),
      ],
    });
    await run(db);
    expect(db.credentials).toHaveLength(4);
  });

  it('keeps one Atlassian credential for every site the account reaches', async () => {
    expect(credentialSiteFor('atlassian', 'https://acme.atlassian.net')).toBeNull();
    expect(credentialSiteFor('zendesk', 'https://acme.zendesk.com')).toBe('https://acme.zendesk.com');
    const one = tokenConnection({ token: 'me@acme.io:ATATT', provider: 'atlassian', site: 'https://acme.atlassian.net' });
    const two = tokenConnection({ token: 'me@acme.io:ATATT', provider: 'atlassian', site: 'https://beta.atlassian.net', workspaceId: WS_B });
    const db = fakeDb({ connections: [one, two] });
    await run(db);
    expect(db.credentials).toHaveLength(1);
    expect(db.credentials[0].site).toBeNull();
    // The connection keeps its own site: that is where the workspace dials.
    expect(two.site).toBe('https://beta.atlassian.net');
  });

  it('is idempotent, and takes a later rotation of the old column into the credential', async () => {
    const a = tokenConnection({ token: 'glpat-old' });
    const db = fakeDb({ connections: [a] });
    await run(db);
    expect(await run(db)).toBe(0);
    // The previous release rotates the connection only.
    Object.assign(a, { credential: encryptSecret('glpat-new', key), updatedAt: new Date(Date.now() + 3_600_000) });
    expect(await run(db)).toBe(1);
    expect(db.credentials).toHaveLength(1);
    expect(secretOf(db, a.id)).toBe('glpat-new');
  });

  it('leaves a token it cannot decrypt where it is', async () => {
    const db = fakeDb({ connections: [tokenConnection({ token: 'x', credential: encryptSecret('x', randomBytes(32)) })] });
    expect(await run(db)).toBe(0);
    expect(db.credentials).toHaveLength(0);
  });
});

describe('backfillCredentials: sign-ins', () => {
  it('moves a GitHub sign-in once per person and refreshes it from a newer row', async () => {
    const token = {
      id: 'unused',
      userId: ANN,
      githubUserId: 42n,
      githubLogin: 'ann',
      githubAvatarUrl: null,
      accessToken: encryptSecret('ghu_1', key),
      refreshToken: null,
      expiresAt: null,
      refreshExpiresAt: null,
      createdAt: past,
      updatedAt: past,
    };
    const db = fakeDb({ githubTokens: [token] });
    await run(db);
    expect(db.credentials).toHaveLength(1);
    expect(db.credentials[0]).toMatchObject({ userId: ANN, provider: 'github', method: 'oauth', accountId: '42', accountLabel: 'ann' });
    expect(await run(db)).toBe(0);
    Object.assign(token, { accessToken: encryptSecret('ghu_2', key), updatedAt: new Date(Date.now() + 3_600_000) });
    expect(await run(db)).toBe(1);
    expect(db.credentials).toHaveLength(1);
    expect(decryptSecret(db.credentials[0].secret as string, key)).toBe('ghu_2');
  });

  it('moves a Figma grant to the person who connected it and binds every workspace using it', async () => {
    const grant = {
      id: 'unused',
      figmaUserId: 'f-1',
      handle: 'ann',
      accessToken: encryptSecret('figu_1', key),
      refreshToken: encryptSecret('figr_1', key),
      expiresAt: past,
      connectedBy: null,
      createdAt: past,
      updatedAt: past,
    };
    const inA = { ...tokenConnection({ token: 'x' }), provider: 'figma', method: 'oauth', site: null, credential: null, externalRef: 'f-1' };
    const inB = { ...inA, id: randomUUID(), workspaceId: WS_B };
    const db = fakeDb({ connections: [inA, inB], figmaGrants: [grant] });
    await run(db);
    expect(db.credentials).toHaveLength(1);
    expect(db.credentials[0]).toMatchObject({ userId: null, provider: 'figma', method: 'oauth', accountId: 'f-1' });
    expect([inA.credentialId, inB.credentialId]).toEqual([db.credentials[0].id, db.credentials[0].id]);
  });
});
