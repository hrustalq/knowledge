import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { AUDIT_ACTIONS } from '@knowledge/contracts';
import { AuditService, redactParams } from '../src/auth/audit.service.js';
import { AuditRetentionSweeper } from '../src/admin/audit-retention.sweeper.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { AuthFlowService } from '../src/auth/auth-flow.service.js';
import { hashPassword } from '../src/auth/password.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * The audit trail (#75 phase 1). What is pinned:
 * - a platform event has no workspace, and a write failure never reaches the caller;
 * - a page is newest first with an id tiebreak, and `nextCursor` appears only
 *   when there is more;
 * - a sign-in and a failed one are recorded, the failure with its real reason
 *   and never the password;
 * - every AUDIT_ACTIONS value is written by some code path in src/.
 */

function fakePrisma(rows: unknown[] = []) {
  return {
    auditLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => rows),
    },
  };
}

const row = (id: string) => ({
  id, workspaceId: null, actor: 'u1', action: 'auth.login', params: {}, rowCount: null,
  durationMs: null, ok: true, error: null, ip: '203.0.113.7', target: 'u1', createdAt: new Date('2026-10-18T10:00:00Z'),
});

describe('AuditService', () => {
  it('records a platform event with no workspace, and caps oversized params', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as never);
    await audit.record({ workspaceId: null, actor: 'u1', action: 'auth.login', params: { blob: 'x'.repeat(20_000) }, ok: true, ip: '203.0.113.7' });
    const data = prisma.auditLog.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).toMatchObject({ workspaceId: null, ip: '203.0.113.7', target: null });
    expect(data.params).toMatchObject({ truncated: true });
  });

  it('swallows a write failure', async () => {
    const prisma = fakePrisma();
    prisma.auditLog.create.mockRejectedValueOnce(new Error('db down'));
    const audit = new AuditService(prisma as never);
    await expect(audit.record({ workspaceId: 'w1', actor: 'u1', action: 'graph.query', params: {}, ok: true })).resolves.toBeUndefined();
  });

  it('pages newest first, filtering by workspace and action', async () => {
    const prisma = fakePrisma([row('a'), row('b'), row('c')]);
    const audit = new AuditService(prisma as never);
    const page = await audit.list('w1', { limit: 2, action: 'auth.login', cursor: 'z' });
    const args = prisma.auditLog.findMany.mock.calls[0][0] as never as Record<string, unknown>;
    expect(args).toMatchObject({
      where: { workspaceId: 'w1', action: 'auth.login' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      cursor: { id: 'z' },
      skip: 1,
      take: 3,
    });
    expect(page.entries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe('b');
    expect(page.entries[0]).toMatchObject({ workspaceId: null, ip: '203.0.113.7', target: 'u1' });
  });

  it('ends the listing when nothing is left, and the platform view has no workspace filter', async () => {
    const prisma = fakePrisma([row('a')]);
    const audit = new AuditService(prisma as never);
    const page = await audit.listPlatform();
    const args = prisma.auditLog.findMany.mock.calls[0][0] as never as Record<string, unknown>;
    expect(args.where).toEqual({});
    expect(page.nextCursor).toBeNull();
  });
});

describe('audit filters, export, redaction and retention (#1251)', () => {
  it('filters by actor and an inclusive date range, and the export reads the same set', async () => {
    const prisma = fakePrisma([row('a')]);
    const audit = new AuditService(prisma as never);
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-11-02T23:59:59.999Z');
    await audit.list('w1', { actor: 'u1', from, to, ok: false });
    await audit.exportRows('w1', { actor: 'u1', from, to, ok: false });
    const [listed, exported] = prisma.auditLog.findMany.mock.calls.map((c) => (c as never as [{ where: unknown }])[0].where);
    expect(listed).toEqual({ workspaceId: 'w1', actor: 'u1', ok: false, createdAt: { gte: from, lte: to } });
    expect(exported).toEqual(listed);
  });

  it('a category is an action list, and an action outside it matches nothing', async () => {
    const prisma = fakePrisma();
    const audit = new AuditService(prisma as never);
    await audit.listPlatform({ category: 'people' });
    await audit.listPlatform({ category: 'people', action: 'auth.login' });
    const [people, mismatch] = prisma.auditLog.findMany.mock.calls.map((c) => (c as never as [{ where: { action: unknown } }])[0].where.action);
    expect((people as { in: string[] }).in).toEqual(expect.arrayContaining(['member.updated', 'user.created', 'api-key.revoked']));
    expect((people as { in: string[] }).in).not.toContain('auth.login');
    expect(mismatch).toEqual({ in: [] });
  });

  it('never stores a secret, by key or by shape, and keeps flags', async () => {
    expect(
      redactParams({
        name: 'GitHub',
        webhookSecret: 'hunter2',
        nested: { apiKey: 'abc', note: 'pasted sk-ant-0123456789abcdefghijklmn' },
        hasToken: true,
        fields: ['credential', 'name'],
      }),
    ).toEqual({
      name: 'GitHub',
      webhookSecret: '[redacted]',
      nested: { apiKey: '[redacted]', note: '[redacted]' },
      hasToken: true,
      fields: ['credential', 'name'],
    });
  });

  it('with AUDIT_RETENTION_DAYS unset (0), the sweeper deletes nothing', async () => {
    const prisma = { $executeRaw: vi.fn(async () => 0) };
    const sweeper = new AuditRetentionSweeper(prisma as never, { get: () => 0 } as never);
    sweeper.onModuleInit();
    await sweeper.sweep();
    sweeper.onModuleDestroy();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('copies an audited feed row into the trail, and only those', async () => {
    const prisma = { activityLog: { create: vi.fn(async () => ({})) } };
    const audit = { record: vi.fn(async () => undefined) };
    const activity = new ActivityService(prisma as never, { publish: async () => undefined } as never, audit as never);
    await activity.record({ workspaceId: 'w1', actor: 'u1', action: 'connector.updated', projectId: 'p1', subjectId: 'c1', metadata: { title: 'Repo', fields: ['name'] } });
    await activity.record({ workspaceId: 'w1', actor: 'u1', action: 'document.updated', projectId: 'p1', documentId: 'd1' });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      workspaceId: 'w1', actor: 'u1', action: 'connector.updated', target: 'c1', ok: true,
      params: { title: 'Repo', fields: ['name'], projectId: 'p1' },
    });
  });
});

describe('sign-in audit', () => {
  const config = { get: (k: string) => ({ NODE_ENV: 'test', AUTH_SESSION_TTL_HOURS: 720 })[k] };

  async function flowWith(user: Record<string, unknown> | null) {
    const audit = { record: vi.fn(async () => undefined) };
    const sessions = { create: vi.fn(async () => ({ token: 'ks_t', session: { id: 's1', expiresAt: new Date() } })) };
    const prisma = {
      user: { findUnique: vi.fn(async () => user) },
      workspaceMember: { findMany: vi.fn(async () => []) },
    };
    const flow = new AuthFlowService(prisma as never, config as never, sessions as never, {} as never, audit as never, noAuthPolicy);
    return { flow, audit, sessions };
  }

  const account = async () => ({
    id: 'u1', email: 'a@example.com', displayName: 'A', isAdmin: false, locale: 'en', disabledAt: null,
    emailVerifiedAt: null, avatarKey: null, avatarUpdatedAt: null, passwordHash: await hashPassword('correct horse'),
  });
  const meta = { ip: '203.0.113.7', userAgent: 'UA' };

  it('records a sign-in and stores where it came from on the session', async () => {
    const { flow, audit, sessions } = await flowWith(await account());
    const res = await flow.login('A@Example.com', 'correct horse', meta);
    expect(res.me.authMethod).toBe('password');
    expect(sessions.create).toHaveBeenCalledWith('u1', { authMethod: 'password', ip: meta.ip, userAgent: 'UA' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: null, actor: 'u1', action: 'auth.login', ok: true, ip: meta.ip, target: 'u1' }),
    );
  });

  it.each([
    ['unknown-email', null, 'correct horse'],
    ['wrong-password', 'account', 'wrong'],
  ])('records a failed sign-in (%s) with the uniform 401 and no password', async (reason, who, password) => {
    const { flow, audit } = await flowWith(who ? await account() : null);
    await expect(flow.login('a@example.com', password, meta)).rejects.toBeInstanceOf(UnauthorizedException);
    const entry = audit.record.mock.calls[0][0] as never as Record<string, unknown>;
    expect(entry).toMatchObject({ action: 'auth.login_failed', actor: 'anonymous', ok: false, error: reason, ip: meta.ip });
    expect(entry.target).toBe(who ? 'u1' : null);
    expect(JSON.stringify(entry)).not.toContain(password === 'wrong' ? '"wrong"' : 'correct horse');
  });
});

describe('AUDIT_ACTIONS', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('promises no action that nothing records', () => {
    const src = sources(join(import.meta.dirname, '..', 'src'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const unused = AUDIT_ACTIONS.filter((a) => !new RegExp(`action: '${a.replace(/\./g, '\\.')}'`).test(src));
    expect(unused).toEqual([]);
  });
});
