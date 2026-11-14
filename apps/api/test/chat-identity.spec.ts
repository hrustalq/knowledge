import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChatIdentityService } from '../src/chat/chat-identity.service.js';
import { ChatWebhookController } from '../src/chat/chat-webhook.controller.js';
import { hashInboundSecret } from '../src/chat/adapters/telegram.adapter.js';
import { TelegramAdapter } from '../src/chat/adapters/telegram.adapter.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Linking a messenger account (issue #71). The code proves the account, the
 * session proves the person: stored hashed, spent once, refused once expired,
 * and refused to anybody who is not a member of the bot's workspace.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const alice: Principal = {
  userId: 'u-alice',
  email: 'a@x.test',
  displayName: 'Alice',
  avatarUrl: null,
  mode: 'session',
  isAdmin: false,
  locale: 'en',
};
const integration = { id: 'int-1', workspaceId: WS, kind: 'telegram', name: 'Team bot', botUsername: 'kn_bot' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function harness(code: Partial<{ usedAt: Date | null; expiresAt: Date }> = {}, member = true) {
  const codes: Array<Record<string, unknown>> = [];
  const row = {
    id: 'code-1',
    integrationId: 'int-1',
    externalUserId: '42',
    externalUserName: '@alice',
    externalChatId: '42',
    codeHash: sha('the-code'),
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    integration,
    ...code,
  };
  const prisma = {
    withTransaction: async (fn: () => Promise<unknown>) => fn(),
    onCommit: (fn: () => Promise<unknown>) => void fn(),
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
    chatLinkCode: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        codes.push(data);
        return data;
      }),
      findUnique: vi.fn(async ({ where }: { where: { codeHash: string } }) => (where.codeHash === row.codeHash ? row : null)),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.integrationId === row.integrationId &&
        where.externalUserId === row.externalUserId &&
        where.externalChatId === row.externalChatId &&
        row.usedAt === null &&
        (row as Record<string, unknown>).confirmedBy
          ? row
          : null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.usedAt === null && row.usedAt !== null) return { count: 0 };
        const { proofAttempts, ...rest } = data;
        if (typeof proofAttempts === 'object') (row as Record<string, unknown>).proofAttempts = Number((row as Record<string, unknown>).proofAttempts ?? 0) + 1;
        else if (proofAttempts !== undefined) (row as Record<string, unknown>).proofAttempts = proofAttempts;
        Object.assign(row, rest);
        return { count: 1 };
      }),
    },
    chatIdentity: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'ident-1', linkedAt: new Date(), ...create })),
    },
    workspace: { findUnique: vi.fn(async () => ({ name: 'Acme' })) },
  };
  const membership = { member };
  const access = {
    requireRole: vi.fn(async () => {
      if (!membership.member) throw new ForbiddenException('not a member');
    }),
    principalFor: vi.fn(async (userId: string) => ({ ...alice, userId })),
  };
  const postMessage = vi.fn(async () => ({ chatId: '42', messageId: '1' }));
  const notify = vi.fn(async () => [{ userId: 'u-alice' }]);
  const announce = vi.fn(async () => undefined);
  const svc = new ChatIdentityService(
    prisma as never,
    access as never,
    { context: () => ({ token: 'T', botUsername: 'kn_bot' }) } as never,
    { get: () => ({ postMessage, render: (v: unknown) => v }) } as never,
    { get: (k: string) => ({ CHAT_LINK_CODE_TTL_MINUTES: 15, WEB_BASE_URL: 'https://kn.test/' })[k] } as never,
    { notify } as never,
    { announce } as never,
  );
  return { svc, prisma, access, codes, postMessage, row, notify, membership };
}

describe('issueCode', () => {
  it('stores only the hash, expires in the configured minutes, and links to the web app', async () => {
    const h = harness();
    const before = Date.now();
    const { url, minutes } = await h.svc.issueCode(integration as never, { externalUserId: '42', externalUserName: '@alice', chatId: '42' });
    const code = new URL(url).searchParams.get('code')!;
    expect(url.startsWith('https://kn.test/chat/link?code=')).toBe(true);
    expect(minutes).toBe(15);
    expect(h.codes[0].codeHash).toBe(sha(code));
    expect(JSON.stringify(h.codes[0])).not.toContain(code);
    const expires = (h.codes[0].expiresAt as Date).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(h.prisma.chatLinkCode.deleteMany).toHaveBeenCalledWith({
      where: { integrationId: 'int-1', externalUserId: '42', usedAt: null },
    });
  });
});

// #1104: the confirmation proves a person, the code proves the account, and
// only a number sent back from that account's own private chat ties the two.
describe('confirm', () => {
  it('hands back a one-time number and links nothing yet', async () => {
    const h = harness();
    const pending = await h.svc.confirm('the-code', alice);
    expect(pending).toMatchObject({ proof: expect.stringMatching(/^\d{6}$/), botUsername: 'kn_bot', kind: 'telegram' });
    expect(h.access.requireRole).toHaveBeenCalledWith(alice, WS, 'viewer');
    expect(h.prisma.chatIdentity.upsert).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({ confirmedBy: 'u-alice', usedAt: null });
    expect(JSON.stringify(h.row)).not.toContain(`"${pending.proof}"`);
  });

  it('refuses an unknown, used or expired code', async () => {
    await expect(harness().svc.confirm('wrong', alice)).rejects.toBeInstanceOf(BadRequestException);
    await expect(harness({ usedAt: new Date() }).svc.confirm('the-code', alice)).rejects.toMatchObject({
      response: { reason: 'chat.linkCodeUsed' },
    });
    await expect(harness({ expiresAt: new Date(Date.now() - 1) }).svc.confirm('the-code', alice)).rejects.toMatchObject({
      response: { reason: 'chat.linkCodeExpired' },
    });
  });

  it('refuses somebody who is not a member of the bot’s workspace, before touching the code', async () => {
    const h = harness({}, false);
    await expect(h.svc.confirm('the-code', alice)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.chatLinkCode.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.chatIdentity.upsert).not.toHaveBeenCalled();
  });
});

describe('redeemProof', () => {
  const account = { externalUserId: '42', chatId: '42' };

  it('links once the number comes back from the same private chat, tells the chat and notifies the person', async () => {
    const h = harness();
    const { proof } = await h.svc.confirm('the-code', alice);
    await expect(h.svc.redeemProof(integration as never, account, proof)).resolves.toBe('linked');
    expect(h.prisma.chatIdentity.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ userId: 'u-alice', externalUserId: '42' }) }));
    expect(h.row.usedAt).not.toBeNull();
    await vi.waitFor(() => expect(h.postMessage).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['u-alice'], type: 'chat.identity.linked', workspaceId: WS })),
    );
  });

  it('ignores a number from another account or chat', async () => {
    const h = harness();
    const { proof } = await h.svc.confirm('the-code', alice);
    await expect(h.svc.redeemProof(integration as never, { externalUserId: '43', chatId: '43' }, proof)).resolves.toBe('none');
    expect(h.prisma.chatIdentity.upsert).not.toHaveBeenCalled();
  });

  it('has nothing to redeem before anybody confirmed', async () => {
    const h = harness();
    await expect(h.svc.redeemProof(integration as never, account, '123456')).resolves.toBe('none');
  });

  it('spends the code after five wrong numbers', async () => {
    const h = harness();
    const { proof } = await h.svc.confirm('the-code', alice);
    const wrong = proof === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) await expect(h.svc.redeemProof(integration as never, account, wrong)).resolves.toBe('mismatch');
    expect(h.row.usedAt).not.toBeNull();
    await expect(h.svc.redeemProof(integration as never, account, proof)).resolves.toBe('none');
    expect(h.prisma.chatIdentity.upsert).not.toHaveBeenCalled();
  });

  it('refuses when the confirming person has left the workspace since', async () => {
    const h = harness();
    const { proof } = await h.svc.confirm('the-code', alice);
    h.membership.member = false;
    await expect(h.svc.redeemProof(integration as never, account, proof)).resolves.toBe('refused');
    expect(h.prisma.chatIdentity.upsert).not.toHaveBeenCalled();
  });
});

describe('ChatWebhookController', () => {
  function controller(enabled: boolean, row: Record<string, unknown> | null) {
    const receive = vi.fn(async () => undefined);
    const ctl = new ChatWebhookController(
      { find: vi.fn(async () => row), context: () => ({ token: 'T', botUsername: 'kn_bot', serverUrl: null, actionUrl: '' }) } as never,
      { get: () => new TelegramAdapter('https://api.telegram.test') } as never,
      { receive } as never,
      { get: () => enabled } as never,
    );
    return { ctl, receive };
  }
  const body = JSON.stringify({ message: { message_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' }, text: 'hi' } });
  const req = (b: string) => ({ rawBody: Buffer.from(b) }) as never;
  const id = '22222222-2222-4222-8222-222222222222';
  const row = { id, enabled: true, kind: 'telegram', botUsername: 'kn_bot', inboundSecretHash: hashInboundSecret('s3cret') };

  it('404s while CHAT_ENABLED is off', async () => {
    const { ctl, receive } = controller(false, row);
    await expect(ctl.receive(id, { 'x-telegram-bot-api-secret-token': 's3cret' }, req(body))).rejects.toBeInstanceOf(NotFoundException);
    expect(receive).not.toHaveBeenCalled();
  });

  it('401s a wrong secret and hands nothing on', async () => {
    const { ctl, receive } = controller(true, row);
    await expect(ctl.receive(id, { 'X-Telegram-Bot-Api-Secret-Token': 'nope' }, req(body))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(receive).not.toHaveBeenCalled();
  });

  it('hands a verified message on and answers 200 at once', async () => {
    const { ctl, receive } = controller(true, row);
    await expect(ctl.receive(id, { 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }, req(body))).resolves.toEqual({ ok: true });
    expect(receive).toHaveBeenCalledWith(row, expect.objectContaining({ text: 'hi', isDm: true }));
  });
});
