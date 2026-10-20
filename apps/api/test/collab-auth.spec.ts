import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { collabDocName } from '@knowledge/contracts';
import { TokenAuthService } from '../src/auth/token-auth.service.js';
import { UrlTicketsService, type TicketStore } from '../src/auth/url-tickets.service.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { CollabGateway } from '../src/collab/collab.gateway.js';

/**
 * Who may join a shared draft, and who keeps it (#80, phase 2). What is pinned:
 * - `/v1/collab` admits a `kt_` ticket once and nothing else: a reused,
 *   expired or long-lived credential is `unauthorized`;
 * - a credential that stops standing (disabled account, revoked key, ended
 *   session) is noticed by `isCurrent`;
 * - the re-check closes a connection per reason — `unauthorized`,
 *   `forbidden`, `access-changed` on a read/write flip — and leaves an
 *   unchanged one alone, filtered by the workspace an `acl.changed` names;
 * - awareness `user` identity is the principal's, whatever the client claims.
 * The same rules against real Hocuspocus and real people: collab-auth.e2e-spec.ts.
 */

const WS = '75700000-0000-4075-8075-000000000007';
const OTHER_WS = '75700000-0000-4075-8075-000000000008';
const DOC = '11111111-1111-4111-8111-111111111111';
const BRANCH = '22222222-2222-4222-8222-222222222222';
const alice: Principal = { ...DEV_PRINCIPAL, userId: 'u-alice', displayName: 'Alice', mode: 'session', isAdmin: false, sessionId: 's1' };

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

const config = (mode = 'api-key') => ({ get: (k: string) => ({ AUTH_MODE: mode, AUTH_URL_TICKET_TTL_SEC: 60 })[k] });

function authWith(prisma: unknown = {}, mode = 'api-key') {
  const store = new FakeStore();
  const tickets = new UrlTicketsService(config(mode) as never, store);
  return { auth: new TokenAuthService(config(mode) as never, prisma as never, {} as never, tickets), tickets, store };
}

describe('TokenAuthService.resolveTicket', () => {
  it('admits a kt_ ticket once, as its minter', async () => {
    const { auth, tickets } = authWith();
    const { ticket } = await tickets.mint(alice);
    expect((await auth.resolveTicket(ticket)).userId).toBe('u-alice');
    await expect(auth.resolveTicket(ticket)).rejects.toThrow();
  });

  it('refuses an expired ticket, a session token, an API key and nothing at all', async () => {
    const { auth, tickets, store } = authWith();
    const { ticket } = await tickets.mint(alice);
    store.now = 61_000;
    await expect(auth.resolveTicket(ticket)).rejects.toThrow();
    for (const token of ['ks_session', 'kn_key', undefined]) await expect(auth.resolveTicket(token)).rejects.toThrow();
  });

  it('is the dev principal under AUTH_MODE=none', async () => {
    const { auth } = authWith({}, 'none');
    expect(await auth.resolveTicket(undefined)).toBe(DEV_PRINCIPAL);
  });
});

describe('TokenAuthService.isCurrent', () => {
  const rows = (o: { disabledAt?: Date | null; key?: object | null; session?: object | null }) => ({
    user: { findUnique: async () => ({ disabledAt: o.disabledAt ?? null }) },
    apiKey: { findUnique: async () => (o.key === undefined ? { revokedAt: null, expiresAt: null } : o.key) },
    session: { findUnique: async () => (o.session === undefined ? { revokedAt: null, expiresAt: new Date(Date.now() + 1e6) } : o.session) },
  });
  const keyed: Principal = { ...alice, mode: 'api-key', sessionId: undefined, apiKey: { id: 'k1', scope: 'write', workspaceId: null } };

  it('holds for a live session and a live key', async () => {
    expect(await authWith(rows({})).auth.isCurrent(alice)).toBe(true);
    expect(await authWith(rows({})).auth.isCurrent(keyed)).toBe(true);
  });

  it('fails for a disabled account, a revoked or expired key, an ended session', async () => {
    expect(await authWith(rows({ disabledAt: new Date() })).auth.isCurrent(alice)).toBe(false);
    expect(await authWith(rows({ key: { revokedAt: new Date(), expiresAt: null } })).auth.isCurrent(keyed)).toBe(false);
    expect(await authWith(rows({ key: { revokedAt: null, expiresAt: new Date(1) } })).auth.isCurrent(keyed)).toBe(false);
    expect(await authWith(rows({ session: null })).auth.isCurrent(alice)).toBe(false);
  });

  it('always holds for the dev principal', async () => {
    expect(await authWith().auth.isCurrent(DEV_PRINCIPAL)).toBe(true);
  });
});

/** A gateway with only what the re-check and the roster touch, and one document holding `connections`. */
function gatewayWith(opts: { current?: boolean; level: 'none' | 'view' | 'edit' }, connections: Array<{ workspaceId: string; readOnly: boolean }>) {
  const gw = Object.create(CollabGateway.prototype) as CollabGateway & Record<string, unknown>;
  const closed: Array<string | undefined> = [];
  const conns = connections.map((c) => ({
    readOnly: c.readOnly,
    context: { principal: alice, workspaceId: c.workspaceId, documentId: DOC },
    close: (e?: { reason?: string }) => closed.push(e?.reason),
  }));
  const rank = { none: 0, view: 1, edit: 2 }[opts.level];
  Object.assign(gw, {
    logger: { warn: vi.fn() },
    pending: null,
    sweeping: false,
    tokenAuth: { isCurrent: async () => opts.current ?? true },
    permissions: {
      requireResource: async (_p: Principal, _w: string, _r: unknown, role: string) => {
        if ((role === 'editor' ? 2 : 1) > rank) throw new ForbiddenException();
      },
    },
    hocuspocus: { documents: new Map([[collabDocName(WS, DOC, BRANCH), { getConnections: () => conns }]]) },
  });
  const settle = async () => {
    for (let i = 0; i < 20 && (gw.sweeping as boolean); i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { recheck: (ws?: string) => (gw as unknown as { recheck(ws?: string): void }).recheck(ws), settle, closed, gw };
}

describe('CollabGateway re-check', () => {
  it('leaves a connection whose access is unchanged', async () => {
    const g = gatewayWith({ level: 'edit' }, [{ workspaceId: WS, readOnly: false }]);
    g.recheck();
    await g.settle();
    expect(g.closed).toEqual([]);
  });

  it('closes a demoted writer and a promoted reader with access-changed', async () => {
    const demoted = gatewayWith({ level: 'view' }, [{ workspaceId: WS, readOnly: false }]);
    demoted.recheck();
    await demoted.settle();
    expect(demoted.closed).toEqual(['access-changed']);

    const promoted = gatewayWith({ level: 'edit' }, [{ workspaceId: WS, readOnly: true }]);
    promoted.recheck();
    await promoted.settle();
    expect(promoted.closed).toEqual(['access-changed']);
  });

  it('closes a page that can no longer be opened, and a credential that no longer stands', async () => {
    const gone = gatewayWith({ level: 'none' }, [{ workspaceId: WS, readOnly: true }]);
    gone.recheck();
    await gone.settle();
    expect(gone.closed).toEqual(['forbidden']);

    const revoked = gatewayWith({ level: 'edit', current: false }, [{ workspaceId: WS, readOnly: false }]);
    revoked.recheck();
    await revoked.settle();
    expect(revoked.closed).toEqual(['unauthorized']);
  });

  it('re-checks only the workspace an acl.changed names', async () => {
    const g = gatewayWith({ level: 'none' }, [
      { workspaceId: WS, readOnly: false },
      { workspaceId: OTHER_WS, readOnly: false },
    ]);
    g.recheck(OTHER_WS);
    await g.settle();
    expect(g.closed).toEqual(['forbidden']);
  });
});

describe('CollabGateway roster', () => {
  it('overwrites the identity a client claims and keeps its other fields', () => {
    const { gw } = gatewayWith({ level: 'edit' }, []);
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { userId: 'u-mallory', name: 'Mallory', avatarUrl: 'x', color: '#f00' }, cursor: 3 }],
      [2, { user: 'not an object' }],
    ]);
    (gw as unknown as { attest(p: unknown): void }).attest({ context: { principal: alice }, states });
    expect(states.get(1)).toEqual({ user: { userId: 'u-alice', name: 'Alice', avatarUrl: null, color: '#f00' }, cursor: 3 });
    expect(states.get(2)).toEqual({ user: { userId: 'u-alice', name: 'Alice', avatarUrl: null } });
  });

  it('leaves an update relayed from another instance alone', () => {
    const { gw } = gatewayWith({ level: 'edit' }, []);
    const states = new Map([[1, { user: { userId: 'u-bob', name: 'Bob' } }]]);
    (gw as unknown as { attest(p: unknown): void }).attest({ context: undefined, states });
    expect(states.get(1)).toEqual({ user: { userId: 'u-bob', name: 'Bob' } });
  });
});
