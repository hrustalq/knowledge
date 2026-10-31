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
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    chatIdentity: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ id: 'ident-1', linkedAt: new Date(), ...create })),
    },
    workspace: { findUnique: vi.fn(async () => ({ name: 'Acme' })) },
  };
  const access = {
    requireRole: vi.fn(async () => {
      if (!member) throw new ForbiddenException('not a member');
    }),
  };
  const postMessage = vi.fn(async () => ({ chatId: '42', messageId: '1' }));
  const svc = new ChatIdentityService(
    prisma as never,
    access as never,
    { context: () => ({ token: 'T', botUsername: 'kn_bot' }) } as never,
    { get: () => ({ postMessage, render: (v: unknown) => v }) } as never,
    { get: (k: string) => ({ CHAT_LINK_CODE_TTL_MINUTES: 15, WEB_BASE_URL: 'https://kn.test/' })[k] } as never,
  );
  return { svc, prisma, access, codes, postMessage };
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

describe('confirm', () => {
  it('links the account to the signed-in member and tells the chat', async () => {
    const h = harness();
    const entry = await h.svc.confirm('the-code', alice);
    expect(entry).toMatchObject({ userId: 'u-alice', externalUserId: '42', workspaceId: WS, kind: 'telegram' });
    expect(h.access.requireRole).toHaveBeenCalledWith(alice, WS, 'viewer');
    await vi.waitFor(() => expect(h.postMessage).toHaveBeenCalledOnce());
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

  it('refuses somebody who is not a member of the bot’s workspace, before spending the code', async () => {
    const h = harness({}, false);
    await expect(h.svc.confirm('the-code', alice)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.prisma.chatLinkCode.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.chatIdentity.upsert).not.toHaveBeenCalled();
  });

  it('two confirmations racing link once', async () => {
    const h = harness();
    h.prisma.chatLinkCode.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.svc.confirm('the-code', alice)).rejects.toMatchObject({ response: { reason: 'chat.linkCodeUsed' } });
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
