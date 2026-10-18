import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { I18nJsonLoader, I18nModule } from 'nestjs-i18n';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { hashToken } from '../src/auth/auth-tokens.js';
import { noAuthPolicy } from './auth-policy-fakes.js';

/**
 * Mailer (docs/features/41). What is pinned:
 * - both catalogues carry the same keys with the same placeholders, and every
 *   template renders a translated subject and its link in both languages;
 * - one email per inbox row: the processor claims `emailed_at` with a guarded
 *   update, skips unverified / opted-out / disabled recipients, and releases
 *   the claim when the send fails so a retry can claim it again;
 * - `announce` hands only directed reasons to the mailer;
 * - a `kv_` link verifies only the address it was sent to, once; resend has a
 *   cooldown; signup and forgot-password queue rather than send;
 * - AUTH_REQUIRE_VERIFIED_EMAIL refuses only unverified *sessions*.
 */
const SRC = join(import.meta.dirname, '../src');
const { I18nRegistry } = await import('../src/i18n/t.js');
const templates = await import('../src/mail/mail.templates.js');
const { MailProcessor, notificationPath } = await import('../src/mail/mail.processor.js');
const { EventsPublisher } = await import('../src/events/events.publisher.js');
const { AuthFlowService } = await import('../src/auth/auth-flow.service.js');
const { TokenAuthService } = await import('../src/auth/token-auth.service.js');

const moduleRef = await Test.createTestingModule({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: 'en',
      loader: I18nJsonLoader,
      loaderOptions: { path: join(SRC, 'i18n'), watch: false },
    }),
  ],
  providers: [I18nRegistry],
}).compile();
await moduleRef.init();

const config = (overrides: Record<string, unknown> = {}) => ({
  get: (k: string) =>
    ({
      WEB_BASE_URL: 'https://kb.example/',
      AUTH_VERIFY_TTL_HOURS: 48,
      AUTH_RESET_TTL_MIN: 30,
      AUTH_INVITE_TTL_HOURS: 72,
      MAIL_NOTIFICATIONS_ENABLED: true,
      NODE_ENV: 'test',
      ...overrides,
    })[k],
});

describe('mail catalogues', () => {
  const leaves = (node: unknown, prefix = ''): [string, string][] =>
    typeof node === 'string'
      ? [[prefix, node]]
      : Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  const read = (lang: string) => new Map(leaves(JSON.parse(readFileSync(join(SRC, `i18n/${lang}/mail.json`), 'utf8'))));
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('en and ru carry the same keys and placeholders', () => {
    const en = read('en');
    const ru = read('ru');
    expect([...ru.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [key, english] of en) expect(placeholders(ru.get(key)!), key).toEqual(placeholders(english));
  });
});

describe('mail templates', () => {
  const ada = (locale: 'en' | 'ru') => ({ displayName: 'Ada <script>', locale });

  it.each(['en', 'ru'] as const)('renders every message translated, with its link (%s)', (locale) => {
    const rendered = [
      templates.verifyEmailMail(ada(locale), 'https://kb.example/verify-email?token=kv_1', 48),
      templates.passwordResetMail(ada(locale), 'https://kb.example/reset-password?token=kr_1', 30),
      templates.inviteMail(ada(locale), 'https://kb.example/reset-password?token=kr_2&invite=1', 72, 'Grace'),
      templates.passwordChangedMail(ada(locale), 'https://kb.example/forgot-password'),
      templates.notificationMail(ada(locale), {
        reason: 'review-requested',
        actor: 'Grace',
        title: 'Billing',
        url: 'https://kb.example/merge-requests/m1',
        settingsUrl: 'https://kb.example/settings/notifications',
      }),
    ];
    for (const mail of rendered) {
      expect(mail.subject).not.toMatch(/^mail\./);
      expect(mail.text).not.toMatch(/\bmail\.\w/);
      expect(mail.text).toMatch(/https:\/\/kb\.example\//);
      expect(mail.html).toContain('href="https://kb.example/');
      // Names come from users; they are text in the HTML part, never markup.
      expect(mail.html).not.toContain('<script>');
      expect(mail.html).toContain('Ada &lt;script&gt;');
    }
    if (locale === 'ru') expect(rendered[0]!.subject).toBe('Подтвердите адрес электронной почты');
    expect(rendered[2]!.text).toContain('invite=1');
    expect(rendered[4]!.subject).toContain('Grace');
  });
});

describe('notificationPath', () => {
  it('opens the discussion on a merge request, else the page, else the inbox', () => {
    expect(
      notificationPath({ subjectType: 'merge-request', subjectId: 'm1', documentId: 'd1', metadata: { threadId: 't1' } }),
    ).toBe('/merge-requests/m1?thread=t1');
    expect(notificationPath({ subjectType: 'document', subjectId: 'd1', documentId: 'd1', metadata: {} })).toBe(
      '/documents/d1',
    );
    expect(notificationPath({ subjectType: null, subjectId: null, documentId: null, metadata: {} })).toBe('/notifications');
  });
});

describe('MailProcessor — one email per inbox row', () => {
  function setup(opts: { row?: Record<string, unknown>; user?: Record<string, unknown>; pref?: unknown; send?: () => Promise<void> } = {}) {
    const row = {
      id: 'n1',
      workspaceId: 'w1',
      userId: 'u1',
      type: 'document.comment.created',
      reason: 'mention',
      actor: 'u2',
      documentId: 'd1',
      subjectType: 'document',
      subjectId: 'd1',
      title: 'Billing',
      metadata: {},
      readAt: null,
      emailedAt: null,
      ...opts.row,
    };
    let emailedAt: Date | null = (row.emailedAt as Date | null) ?? null;
    const users: Record<string, unknown> = {
      u1: { id: 'u1', email: 'ada@example.com', displayName: 'Ada', locale: 'en', disabledAt: null, emailVerifiedAt: new Date(), ...opts.user },
      u2: { displayName: 'Grace' },
    };
    const prisma = {
      notification: {
        findUnique: vi.fn(async () => ({ ...row, emailedAt })),
        updateMany: vi.fn(async ({ where }: { where: { emailedAt: null } }) => {
          if (where.emailedAt === null && emailedAt === null) {
            emailedAt = new Date();
            return { count: 1 };
          }
          return { count: 0 };
        }),
        update: vi.fn(async ({ data }: { data: { emailedAt: Date | null } }) => {
          emailedAt = data.emailedAt;
        }),
      },
      user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null) },
      notificationPreference: { findUnique: vi.fn(async () => opts.pref ?? null) },
    };
    const send = vi.fn(opts.send ?? (async () => undefined));
    const processor = new MailProcessor(prisma as never, { send, transport: 'log' } as never, config() as never);
    const run = () => processor.process({ data: { template: 'notification', notificationId: 'n1' } } as never);
    return { run, send, emailed: () => emailedAt };
  }

  it('sends once, then finds the row claimed', async () => {
    const { run, send, emailed } = setup();
    await run();
    await run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('ada@example.com');
    expect(send.mock.calls[0]![1].subject).toBe('Grace mentioned you in Billing');
    expect(emailed()).toBeInstanceOf(Date);
  });

  it.each([
    ['an unverified address', { user: { emailVerifiedAt: null } }],
    ['a disabled account', { user: { disabledAt: new Date() } }],
    ['the email preference switched off', { pref: { emailDirected: false } }],
    ['a row already read in the app', { row: { readAt: new Date() } }],
    ['a watch-only reason', { row: { reason: 'watching' } }],
  ])('sends nothing to %s', async (_label, opts) => {
    const { run, send } = setup(opts as never);
    await run();
    expect(send).not.toHaveBeenCalled();
  });

  it('releases the claim when the send fails, so the retry can send', async () => {
    let fail = true;
    const { run, send, emailed } = setup({
      send: async () => {
        if (fail) throw new Error('relay unreachable');
      },
    });
    await expect(run()).rejects.toThrow('relay unreachable');
    expect(emailed()).toBeNull();
    fail = false;
    await run();
    expect(send).toHaveBeenCalledTimes(2);
    expect(emailed()).toBeInstanceOf(Date);
  });

  it('sends nothing at all with MAIL_NOTIFICATIONS_ENABLED=false', async () => {
    const send = vi.fn();
    const processor = new MailProcessor({} as never, { send } as never, config({ MAIL_NOTIFICATIONS_ENABLED: false }) as never);
    await processor.process({ data: { template: 'notification', notificationId: 'n1' } } as never);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('EventsPublisher.announce → mailer', () => {
  it('queues only the directed reasons', async () => {
    const enqueue = vi.fn(async () => undefined);
    const publisher = new EventsPublisher({ get: () => 'redis://localhost:1' } as never, {} as never, { enqueue } as never);
    (publisher as unknown as { redis: unknown }).redis = { publish: async () => 1, disconnect: () => undefined };
    const delivery = (id: string, reason: string) => ({ userId: 'u1', notification: { id, reason } as never });
    await publisher.announce('w1', [
      delivery('n1', 'mention'),
      delivery('n2', 'watching'),
      delivery('n3', 'review-requested'),
      delivery('n4', 'owner'),
      delivery('n5', 'assigned'),
    ]);
    expect(enqueue.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { template: 'notification', notificationId: 'n1' },
      { template: 'notification', notificationId: 'n3' },
      { template: 'notification', notificationId: 'n5' },
    ]);
  });
});

describe('AuthFlowService — verification', () => {
  function setup(user: Record<string, unknown>, tokens: Record<string, unknown>[] = []) {
    const created: Record<string, unknown>[] = [];
    const userUpdates: unknown[] = [];
    const prisma = {
      user: {
        findUnique: vi.fn(async () => user),
        updateMany: vi.fn(async (args: unknown) => {
          userUpdates.push(args);
          return { count: 1 };
        }),
      },
      emailVerificationToken: {
        findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
          const row = tokens.find((r) => r.tokenHash === where.tokenHash);
          return row ? { ...row, user } : null;
        }),
        findFirst: vi.fn(async () => tokens.at(-1) ?? null),
        updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
          const row = tokens.find((r) => r.id === where.id)!;
          if (row.usedAt) return { count: 0 };
          row.usedAt = new Date();
          return { count: 1 };
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        }),
      },
    };
    const mail = { enqueue: vi.fn(async () => undefined) };
    const flow = new AuthFlowService(prisma as never, config() as never, {} as never, mail as never, {} as never, noAuthPolicy);
    return { flow, mail, created, userUpdates };
  }
  const session: Principal = { ...DEV_PRINCIPAL, userId: 'u1', mode: 'session', isAdmin: false, emailVerified: false };
  const ada = { id: 'u1', email: 'ada@example.com', displayName: 'Ada', emailVerifiedAt: null, disabledAt: null };
  const tokenRow = (token: string, extra: Record<string, unknown> = {}) => ({
    id: `t-${token}`,
    userId: 'u1',
    email: 'ada@example.com',
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 3_600_000),
    usedAt: null,
    createdAt: new Date(Date.now() - 120_000),
    ...extra,
  });

  it('verifies once with a valid link; a second click on the spent link is harmless', async () => {
    const { flow, userUpdates } = setup(ada, [tokenRow('kv_ok')]);
    await flow.verifyEmail('kv_ok');
    expect(userUpdates).toHaveLength(1);
    expect(userUpdates[0]).toMatchObject({ where: { id: 'u1', emailVerifiedAt: null } });
  });

  it('refuses an expired link, an unknown one, and one sent to a previous address', async () => {
    const { flow } = setup(ada, [
      tokenRow('kv_old', { expiresAt: new Date(Date.now() - 1) }),
      tokenRow('kv_moved', { email: 'someone-else@example.com' }),
    ]);
    await expect(flow.verifyEmail('kv_old')).rejects.toThrow();
    await expect(flow.verifyEmail('kv_moved')).rejects.toThrow();
    await expect(flow.verifyEmail('kv_nope')).rejects.toThrow();
  });

  it('refuses a spent link when the account is still unverified', async () => {
    const { flow } = setup(ada, [tokenRow('kv_spent', { usedAt: new Date() })]);
    await expect(flow.verifyEmail('kv_spent')).rejects.toThrow();
  });

  it('resend queues a fresh kv_ link, then holds for a minute', async () => {
    const { flow, mail, created } = setup(ada, [tokenRow('kv_1')]);
    const res = await flow.resendVerification(session);
    expect(res.alreadyVerified).toBe(false);
    expect(res.debugToken).toMatch(/^kv_/);
    expect(created[0]).toMatchObject({ userId: 'u1', email: 'ada@example.com', tokenHash: hashToken(res.debugToken!) });
    expect(mail.enqueue).toHaveBeenCalledWith({ template: 'verify-email', userId: 'u1', token: res.debugToken });

    const { flow: again } = setup(ada, [tokenRow('kv_2', { createdAt: new Date() })]);
    await expect(again.resendVerification(session)).rejects.toMatchObject({ status: 429 });
  });

  it('resend sends nothing to a verified address', async () => {
    const { flow, mail } = setup({ ...ada, emailVerifiedAt: new Date() });
    expect(await flow.resendVerification(session)).toEqual({ ok: true, alreadyVerified: true });
    expect(mail.enqueue).not.toHaveBeenCalled();
  });
});

describe('AuthFlowService — forgot-password queues the link', () => {
  it('queues the mail for a known account and nothing for an unknown one, with the same answer shape', async () => {
    const created: unknown[] = [];
    const mail = { enqueue: vi.fn(async () => undefined) };
    const prisma = {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { email: string } }) =>
          where.email === 'ada@example.com' ? { id: 'u1', disabledAt: null } : null,
        ),
      },
      passwordResetToken: { create: vi.fn(async ({ data }: { data: unknown }) => created.push(data)) },
    };
    const flow = new AuthFlowService(prisma as never, config({ NODE_ENV: 'production' }) as never, {} as never, mail as never, {} as never, noAuthPolicy);
    expect(await flow.forgotPassword('nobody@example.com')).toEqual({ ok: true });
    expect(await flow.forgotPassword(' Ada@Example.com ')).toEqual({ ok: true });
    expect(mail.enqueue).toHaveBeenCalledTimes(1);
    expect(mail.enqueue.mock.calls[0]![0]).toMatchObject({ template: 'password-reset', userId: 'u1' });
    expect(created[0]).toMatchObject({ userId: 'u1', purpose: 'reset' });
  });
});

describe('AUTH_REQUIRE_VERIFIED_EMAIL', () => {
  const auth = (required: boolean) =>
    new TokenAuthService(config({ AUTH_REQUIRE_VERIFIED_EMAIL: required }) as never, {} as never, {} as never, {} as never);
  const unverified: Principal = { ...DEV_PRINCIPAL, userId: 'u1', mode: 'session', emailVerified: false };

  it('blocks only an unverified session, and only when switched on', () => {
    expect(auth(true).blocksUnverified(unverified)).toBe(true);
    expect(auth(false).blocksUnverified(unverified)).toBe(false);
    expect(auth(true).blocksUnverified({ ...unverified, emailVerified: true })).toBe(false);
    expect(auth(true).blocksUnverified({ ...unverified, mode: 'api-key' })).toBe(false);
    expect(auth(true).blocksUnverified(DEV_PRINCIPAL)).toBe(false);
  });
});

describe('SMTP credentials', async () => {
  const { smtpOptions } = await import('../src/mail/mail.transport.js');
  const { validateEnv } = await import('../src/config/env.js');
  const { createTransport } = await import('nodemailer');

  it('takes host, port and TLS from the URL and auth verbatim from MAIL_SMTP_USER / MAIL_SMTP_PASS', () => {
    const opts = smtpOptions(
      config({ MAIL_SMTP_URL: 'smtps://smtp.timeweb.ru:465', MAIL_SMTP_USER: 'kb@x.ru', MAIL_SMTP_PASS: 'p@ss:w/rd%' }) as never,
    );
    const { host, port, secure, auth } = (createTransport(opts) as unknown as { options: Record<string, unknown> }).options;
    expect({ host, port, secure, auth }).toEqual({
      host: 'smtp.timeweb.ru',
      port: 465,
      secure: true,
      auth: { user: 'kb@x.ru', pass: 'p@ss:w/rd%' },
    });
  });

  it('leaves a URL with its own userinfo untouched when no user is set', () => {
    expect(smtpOptions(config({ MAIL_SMTP_URL: 'smtps://a:b@h:465', MAIL_SMTP_USER: '' }) as never)).toEqual({
      url: 'smtps://a:b@h:465',
    });
  });

  it('refuses credentials in both places rather than silently preferring the URL', () => {
    const base = Object.fromEntries(
      ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET', 'ARCADE_URL', 'ARCADE_DB', 'ARCADE_USER', 'ARCADE_PASSWORD'].map((k) => [k, 'x']),
    );
    const env = { ...base, MAIL_TRANSPORT: 'smtp', MAIL_SMTP_URL: 'smtps://a:b@h:465', MAIL_SMTP_USER: 'u', MAIL_SMTP_PASS: 'p' };
    expect(() => validateEnv(env)).toThrow(/MAIL_SMTP_USER.*keep one/);
    expect(() => validateEnv({ ...env, MAIL_SMTP_URL: 'smtps://h:465' })).not.toThrow();
  });
});
