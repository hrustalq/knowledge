import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ChatAnswersService } from '../src/chat/chat-answers.service.js';
import { decodeChatAction, encodeChatAction } from '../src/chat/chat-actions.js';
import type { ChatInbound, ChatView } from '../src/chat/adapters/chat-adapter.types.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * Answering in a chat (issue #71, phase 1). What is pinned is who gets an
 * answer and how many: an unlinked account never reaches a model, an unbound
 * group never hears from the bot, a redelivered update answers once, and an
 * account that lost its access is refused on the next message.
 */

const WS = '11111111-1111-4111-8111-111111111111';
/** A claim id — a UUID, because it travels in button data and is decoded as one. */
const ANS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const integration = {
  id: 'int-1',
  workspaceId: WS,
  kind: 'telegram',
  name: 'Team bot',
  enabled: true,
  botUsername: 'kn_bot',
  defaultAgentKey: null,
  locale: 'en',
} as never;

function inbound(over: Partial<ChatInbound> = {}): ChatInbound {
  return {
    externalUserId: '42',
    externalUserName: '@alice',
    chatId: '42',
    chatTitle: null,
    isDm: true,
    messageId: '7',
    text: 'How do we deploy?',
    mentioned: false,
    replyToBotMessageId: null,
    threadId: null,
    command: null,
    action: null,
    ...over,
  };
}

const answerMessage = {
  id: 'msg-1',
  content: 'Deploys go through CI [S1].',
  sources: [{ documentId: 'd1', title: 'Deploy guide', cite: 'S1' }],
};

function harness(opts: {
  linked?: boolean;
  binding?: Record<string, unknown> | null;
  recent?: number;
  duplicate?: boolean;
  principalFails?: boolean;
  turn?: () => Promise<unknown>;
  answered?: Record<string, unknown> | null;
  voteFails?: Error;
} = {}) {
  const posted: ChatView[] = [];
  const edited: ChatView[] = [];
  const acks: Array<string | undefined> = [];
  const adapter = {
    acknowledge: vi.fn(async (_ctx: unknown, _id: string, note?: string) => {
      acks.push(note);
    }),
    render: (view: ChatView) => ({ text: '', plain: '', buttons: [], view }),
    postMessage: vi.fn(async (_ctx: unknown, target: { chatId: string }, msg: { view: ChatView }) => {
      posted.push(msg.view);
      return { chatId: target.chatId, messageId: `bot-${posted.length}` };
    }),
    editMessage: vi.fn(async (_ctx: unknown, _ref: unknown, msg: { view: ChatView }) => {
      edited.push(msg.view);
    }),
    directLink: () => 'https://t.me/kn_bot',
  };
  const claims: Array<Record<string, unknown>> = [];
  const settled: Array<Record<string, unknown>> = [];
  const prisma = {
    workspace: { findUnique: vi.fn(async () => ({ name: 'Acme' })) },
    user: { findUnique: vi.fn(async () => ({ locale: 'ru' })) },
    chatAnswer: {
      count: vi.fn(async () => opts.recent ?? 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.duplicate) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
        claims.push(data);
        return { id: ANS, ...data };
      }),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        settled.push(data);
        return { count: 1 };
      }),
      findFirst: vi.fn(async () => opts.answered ?? null),
      findMany: vi.fn(async () => []),
    },
    assistantMessage: {
      findUnique: vi.fn(async () => ({ threadId: 'thread-1', ...answerMessage })),
    },
    chatConversation: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'conv-1', ...data })),
    },
  };
  const access = {
    principalFor: vi.fn(async () => {
      if (opts.principalFails) throw new ForbiddenException('owner unavailable');
      return DEV_PRINCIPAL;
    }),
    requireRole: vi.fn(async () => undefined),
  };
  const assistant = {
    runChatTurn: vi.fn(opts.turn ?? (async () => ({ enabled: true, message: answerMessage }))),
  };
  const threads = { createThread: vi.fn(async () => ({ thread: { id: 'thread-1' } })) };
  const integrations = {
    context: () => ({ token: 'T', botUsername: 'kn_bot' }),
    findBinding: vi.fn(async () => opts.binding ?? null),
    bindFromChat: vi.fn(async () => 'created'),
    unbindFromChat: vi.fn(async () => true),
  };
  const identities = {
    resolve: vi.fn(async () => (opts.linked === false ? null : { userId: 'u-alice' })),
    issueCode: vi.fn(async () => ({ url: 'https://kn.test/chat/link?code=abc', minutes: 15 })),
    unlinkExternal: vi.fn(async () => true),
  };
  const captures = { start: vi.fn(async () => undefined) };
  const feedback = {
    vote: vi.fn(async () => {
      if (opts.voteFails) throw opts.voteFails;
      return {};
    }),
  };
  const config = {
    get: (key: string) =>
      ({
        WEB_BASE_URL: 'https://kn.test',
        CHAT_MAX_SOURCES: 5,
        CHAT_RATE_LIMIT_PER_USER_PER_MINUTE: 10,
        CHAT_ANSWER_TIMEOUT_SECONDS: 120,
      })[key],
  };
  const svc = new ChatAnswersService(
    prisma as never,
    access as never,
    assistant as never,
    threads as never,
    { get: () => adapter } as never,
    integrations as never,
    identities as never,
    feedback as never,
    captures as never,
    config as never,
  );
  return { svc, prisma, access, assistant, identities, integrations, feedback, captures, posted, edited, acks, claims, settled };
}

describe('an unlinked account', () => {
  it('gets a link code in a DM, and no model call or claim', async () => {
    const h = harness({ linked: false });
    await h.svc.receive(integration, inbound());
    expect(h.identities.issueCode).toHaveBeenCalledOnce();
    expect(h.posted).toEqual([
      { kind: 'notice', text: 'chat.link.required', button: { label: 'chat.link.button', url: 'https://kn.test/chat/link?code=abc' } },
    ]);
    expect(h.assistant.runChatTurn).not.toHaveBeenCalled();
    expect(h.prisma.chatAnswer.create).not.toHaveBeenCalled();
  });

  it('is sent to a private chat from a group — a code is never posted where others can open it', async () => {
    const h = harness({ linked: false, binding: { answerMode: 'mention' } });
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', mentioned: true }));
    expect(h.identities.issueCode).not.toHaveBeenCalled();
    expect(h.posted[0]).toMatchObject({ text: 'chat.link.inGroup', button: { url: 'https://t.me/kn_bot' } });
  });
});

describe('groups', () => {
  it('an unbound group hears nothing, not even help', async () => {
    const h = harness({ binding: null });
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', mentioned: true }));
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', command: { name: 'help', args: '' } }));
    expect(h.posted).toEqual([]);
  });

  it('a mention-mode group answers only when addressed', async () => {
    const h = harness({ binding: { answerMode: 'mention', agentKey: null, projectId: null } });
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', mentioned: false }));
    expect(h.posted).toEqual([]);
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', mentioned: true }));
    expect(h.assistant.runChatTurn).toHaveBeenCalledOnce();
  });

  it('answers with the binding’s agent and project', async () => {
    const h = harness({ binding: { answerMode: 'mention', agentKey: 'support', projectId: 'p-1' } });
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', mentioned: true }));
    expect(h.assistant.runChatTurn).toHaveBeenCalledWith(
      'thread-1',
      // A group reads the answer, so retrieval is clamped to what every member can open (#76).
      { content: 'How do we deploy?', agentKey: 'support', projectId: 'p-1', audience: { kind: 'workspace' } },
      DEV_PRINCIPAL,
    );
  });

  it('answers a direct message with the asker’s own pages, unclamped (#76)', async () => {
    const h = harness({});
    await h.svc.receive(integration, inbound({ isDm: true }));
    expect(h.assistant.runChatTurn).toHaveBeenCalledOnce();
    expect(h.assistant.runChatTurn.mock.calls[0]![1]).not.toHaveProperty('audience');
  });

  it('/bind needs a linked workspace admin', async () => {
    const h = harness({ binding: null });
    h.access.requireRole.mockRejectedValueOnce(new ForbiddenException('not admin'));
    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', command: { name: 'bind', args: '' } }));
    expect(h.integrations.bindFromChat).not.toHaveBeenCalled();
    expect(h.posted[0]).toMatchObject({ text: 'chat.bind.forbidden' });

    await h.svc.receive(integration, inbound({ isDm: false, chatId: '-100', chatTitle: 'Ops', command: { name: 'bind', args: '' } }));
    expect(h.access.requireRole).toHaveBeenLastCalledWith(DEV_PRINCIPAL, WS, 'admin');
    expect(h.integrations.bindFromChat).toHaveBeenCalledWith(integration, { chatId: '-100', title: 'Ops' }, 'u-alice');
  });
});

describe('a linked account', () => {
  it('gets one cited answer: claim, placeholder, the turn as the person, then the edit', async () => {
    const h = harness();
    await h.svc.receive(integration, inbound());
    expect(h.claims).toEqual([
      expect.objectContaining({ inboundMessageId: '7', askedBy: 'u-alice', agentKey: 'researcher', locale: 'ru' }),
    ]);
    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.answer.thinking' }]);
    expect(h.access.principalFor).toHaveBeenCalledWith('u-alice', 'ru');
    expect(h.access.requireRole).toHaveBeenCalledWith(DEV_PRINCIPAL, WS, 'viewer');
    expect(h.edited[0]).toMatchObject({
      kind: 'answer',
      answer: 'Deploys go through CI [S1].',
      sources: [{ cite: 'S1', title: 'Deploy guide', url: 'https://kn.test/documents/d1' }],
      full: { url: 'https://kn.test/assistant?thread=thread-1' },
      actions: [
        [
          { label: '👍', action: `v:${ANS}:u` },
          { label: '👎', action: `v:${ANS}:d` },
          { label: 'chat.capture.save', action: `s:${ANS}` },
        ],
      ],
    });
    expect(h.settled).toEqual([{ status: 'answered', assistantMessageId: 'msg-1' }]);
  });

  it('a redelivered update answers once', async () => {
    const h = harness({ duplicate: true });
    await h.svc.receive(integration, inbound());
    expect(h.posted).toEqual([]);
    expect(h.assistant.runChatTurn).not.toHaveBeenCalled();
  });

  it('a disabled or removed person is refused on the next message, with no claim', async () => {
    const h = harness({ principalFails: true });
    await h.svc.receive(integration, inbound());
    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.answer.noAccess' }]);
    expect(h.prisma.chatAnswer.create).not.toHaveBeenCalled();
  });

  it('over the per-minute ceiling gets "slow down" and no model call', async () => {
    const h = harness({ recent: 10 });
    await h.svc.receive(integration, inbound());
    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.answer.rateLimited' }]);
    expect(h.assistant.runChatTurn).not.toHaveBeenCalled();
  });

  it('a failed turn fails the claim and says why in the placeholder', async () => {
    const h = harness({
      turn: async () => {
        throw new HttpException('over budget', HttpStatus.TOO_MANY_REQUESTS);
      },
    });
    await h.svc.receive(integration, inbound());
    expect(h.settled[0]).toMatchObject({ status: 'failed' });
    expect(h.edited).toEqual([{ kind: 'notice', text: 'chat.answer.budget' }]);
  });

  it('a late answer the reaper already failed is not shown over the timeout notice', async () => {
    const h = harness();
    h.prisma.chatAnswer.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    await h.svc.receive(integration, inbound());
    expect(h.edited).toEqual([]);
  });
});

describe('reapStale', () => {
  it('fails what is pending past the timeout and edits its placeholder, once', async () => {
    const h = harness();
    const row = {
      id: 'ans-9',
      externalChatId: '42',
      replyMessageId: 'bot-3',
      locale: 'ru',
      integration,
    };
    h.prisma.chatAnswer.findMany.mockResolvedValueOnce([row, { ...row, id: 'ans-10' }] as never);
    h.prisma.chatAnswer.updateMany.mockResolvedValueOnce({ count: 1 } as never).mockResolvedValueOnce({ count: 0 } as never);
    expect(await h.svc.reapStale()).toBe(1);
    expect(h.edited).toEqual([{ kind: 'notice', text: 'chat.answer.timeout' }]);
  });
});

describe('button data', () => {
  it('round-trips every action within Telegram’s 64 bytes', () => {
    for (const action of [
      { kind: 'vote', answerId: ANS, rating: 'up' },
      { kind: 'vote', answerId: ANS, rating: 'down' },
      { kind: 'reason', answerId: ANS, reason: 'irrelevant-sources' },
      { kind: 'save-menu', answerId: ANS },
      { kind: 'capture', answerId: ANS, capture: 'page' },
      { kind: 'capture', answerId: ANS, capture: 'glossary-term' },
      { kind: 'back', answerId: ANS },
    ] as const) {
      const data = encodeChatAction(action);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(decodeChatAction(data)).toEqual(action);
    }
  });

  it('decodes nothing it did not write', () => {
    for (const data of ['', 'v:not-a-uuid:u', `v:${ANS}:x`, `r:${ANS}:rude`, `b:${ANS}:u`, `v:${ANS}:u:extra`, `z:${ANS}`, `c:${ANS}:x`, `s:${ANS}:p`]) {
      expect(decodeChatAction(data)).toBeNull();
    }
  });
});

describe('feedback buttons', () => {
  const answered = { id: ANS, assistantMessageId: 'msg-1', locale: 'en' };
  const pressed = (data: string, over: Partial<ChatInbound> = {}) =>
    inbound({ isDm: false, chatId: '-100', messageId: 'bot-1', text: '', action: { id: 'cb-1', data }, ...over });

  it('👍 votes as the presser on the chat surface, says thanks and leaves the buttons alone', async () => {
    const h = harness({ answered });
    await h.svc.receive(integration, pressed(`v:${ANS}:u`));
    expect(h.prisma.chatAnswer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ANS, integrationId: 'int-1', externalChatId: '-100', status: 'answered' } }),
    );
    expect(h.feedback.vote).toHaveBeenCalledWith('msg-1', DEV_PRINCIPAL, { rating: 'up', surface: 'chat' });
    expect(h.acks).toEqual(['chat.feedback.thanks']);
    expect(h.edited).toEqual([]);
  });

  it('👎 is recorded at once, then the reasons replace the vote row', async () => {
    const h = harness({ answered });
    await h.svc.receive(integration, pressed(`v:${ANS}:d`));
    expect(h.feedback.vote).toHaveBeenCalledWith('msg-1', DEV_PRINCIPAL, { rating: 'down', surface: 'chat' });
    expect(h.acks).toEqual(['chat.feedback.askReason']);
    const view = h.edited[0] as Extract<ChatView, { kind: 'answer' }>;
    expect(view.answer).toBe('Deploys go through CI [S1].');
    expect(view.actions.flat().map((b) => decodeChatAction(b.action)?.kind)).toEqual([
      ...Array(7).fill('reason'),
      'back',
    ]);
  });

  it('a reason updates the same vote and puts the vote row back', async () => {
    const h = harness({ answered });
    await h.svc.receive(integration, pressed(`r:${ANS}:outdated`));
    expect(h.feedback.vote).toHaveBeenCalledWith('msg-1', DEV_PRINCIPAL, {
      rating: 'down',
      reason: 'outdated',
      surface: 'chat',
    });
    expect((h.edited[0] as Extract<ChatView, { kind: 'answer' }>).actions).toEqual([
      [
        { label: '👍', action: `v:${ANS}:u` },
        { label: '👎', action: `v:${ANS}:d` },
        { label: 'chat.capture.save', action: `s:${ANS}` },
      ],
    ]);
  });

  it('back restores the vote row without voting', async () => {
    const h = harness({ answered });
    await h.svc.receive(integration, pressed(`b:${ANS}`));
    expect(h.feedback.vote).not.toHaveBeenCalled();
    expect(h.acks).toEqual([undefined]);
    expect(h.edited).toHaveLength(1);
  });

  it('an unlinked presser is told to link, and nothing is recorded', async () => {
    const h = harness({ answered, linked: false });
    await h.svc.receive(integration, pressed(`v:${ANS}:u`));
    expect(h.acks).toEqual(['chat.feedback.linkFirst']);
    expect(h.feedback.vote).not.toHaveBeenCalled();
    expect(h.identities.issueCode).not.toHaveBeenCalled();
  });

  it('a presser who lost access is refused on the press', async () => {
    const h = harness({ answered, principalFails: true });
    await h.svc.receive(integration, pressed(`v:${ANS}:u`));
    expect(h.acks).toEqual(['chat.answer.noAccess']);
    expect(h.feedback.vote).not.toHaveBeenCalled();
  });

  it('an answer not in this chat, or forged data, records nothing but still acknowledges', async () => {
    const h = harness({ answered: null });
    await h.svc.receive(integration, pressed(`v:${ANS}:u`));
    await h.svc.receive(integration, pressed('v:../../x:u'));
    expect(h.acks).toEqual(['chat.feedback.gone', undefined]);
    expect(h.feedback.vote).not.toHaveBeenCalled();
  });

  it('is acknowledged in a group that has since been unbound', async () => {
    const h = harness({ answered, binding: null });
    await h.svc.receive(integration, pressed(`v:${ANS}:u`));
    expect(h.acks).toEqual(['chat.feedback.thanks']);
  });

  it('feedback switched off is said so, not swallowed', async () => {
    const h = harness({ answered, voteFails: new ForbiddenException('off') });
    await h.svc.receive(integration, pressed(`v:${ANS}:d`));
    expect(h.acks).toEqual(['chat.feedback.disabled']);
    expect(h.edited).toEqual([]);
  });
});

describe('save buttons', () => {
  const answered = {
    id: ANS,
    assistantMessageId: 'msg-1',
    conversationId: 'conv-1',
    createdAt: new Date('2026-10-14T10:00:00Z'),
    locale: 'en',
  };
  const pressed = (data: string) =>
    inbound({ isDm: false, chatId: '-100', messageId: 'bot-1', text: '', action: { id: 'cb-1', data } });
  const binding = { answerMode: 'mention', agentKey: null, projectId: 'p-1' };

  it('Save opens the menu for an editor', async () => {
    const h = harness({ answered, binding });
    await h.svc.receive(integration, pressed(`s:${ANS}`));
    expect(h.access.requireRole).toHaveBeenLastCalledWith(DEV_PRINCIPAL, WS, 'editor');
    const view = h.edited[0] as Extract<ChatView, { kind: 'answer' }>;
    expect(view.actions.flat().map((b) => decodeChatAction(b.action))).toEqual([
      { kind: 'capture', answerId: ANS, capture: 'page' },
      { kind: 'capture', answerId: ANS, capture: 'glossary-term' },
      { kind: 'back', answerId: ANS },
    ]);
  });

  it('a viewer is refused on the press and the menu never opens', async () => {
    const h = harness({ answered, binding });
    h.access.requireRole.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ForbiddenException('viewer'));
    await h.svc.receive(integration, pressed(`s:${ANS}`));
    expect(h.acks).toEqual(['chat.capture.forbidden']);
    expect(h.edited).toEqual([]);
  });

  it('a choice puts the vote row back and starts the capture as the presser, in the group’s project', async () => {
    const h = harness({ answered, binding });
    await h.svc.receive(integration, pressed(`c:${ANS}:p`));
    expect(h.acks).toEqual(['chat.capture.savingAnswer']);
    expect((h.edited[0] as Extract<ChatView, { kind: 'answer' }>).actions[0]).toHaveLength(3);
    expect(h.captures.start).toHaveBeenCalledWith(
      expect.objectContaining({
        answerMessage: { chatId: '-100', messageId: 'bot-1' },
        answer: { id: ANS, conversationId: 'conv-1', createdAt: answered.createdAt },
        message: expect.objectContaining({ id: expect.any(String) }),
        projectId: 'p-1',
        principal: DEV_PRINCIPAL,
        kind: 'page',
      }),
    );
  });

  it('a viewer choosing directly (an old menu) is refused and nothing starts', async () => {
    const h = harness({ answered, binding });
    h.access.requireRole.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new ForbiddenException('viewer'));
    await h.svc.receive(integration, pressed(`c:${ANS}:t`));
    expect(h.captures.start).not.toHaveBeenCalled();
  });
});

describe('threads (Time, phase 4)', () => {
  const time = { ...(integration as object), kind: 'time' } as never;
  const bound = { answerMode: 'mention', agentKey: null, projectId: null };
  /** A message in a channel thread, not mentioning the bot. */
  const inThread = (over: Partial<ChatInbound> = {}) =>
    inbound({ isDm: false, chatId: 'ch-1', messageId: 'p2', threadId: 'p1', replyToBotMessageId: 'p1', ...over });

  it('a thread the bot answered in is addressed without a mention, and the claim keeps the thread', async () => {
    const h = harness({ binding: bound, answered: { id: ANS, conversationId: null } });
    await h.svc.receive(time, inThread());
    expect(h.assistant.runChatTurn).toHaveBeenCalledOnce();
    expect(h.claims[0]).toMatchObject({ threadId: 'p1', inboundMessageId: 'p2' });
    // The check looked for the bot in this chat, by thread or by its own reply.
    expect(h.prisma.chatAnswer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalChatId: 'ch-1',
          OR: [{ threadId: 'p1' }, { replyMessageId: 'p1' }],
        }),
      }),
    );
  });

  it('a thread between people stays theirs', async () => {
    const h = harness({ binding: bound, answered: null });
    await h.svc.receive(time, inThread());
    expect(h.assistant.runChatTurn).not.toHaveBeenCalled();
    expect(h.posted).toEqual([]);
  });

  it('a follow-up in the thread continues the asker’s conversation', async () => {
    const h = harness({ binding: bound, answered: { id: ANS, conversationId: 'conv-7' } });
    h.prisma.chatConversation.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) =>
      where.id === 'conv-7' ? { id: 'conv-7', assistantThreadId: 'thread-7' } : null) as never);
    h.prisma.chatConversation.update.mockImplementation((async () => ({ id: 'conv-7', assistantThreadId: 'thread-7' })) as never);
    await h.svc.receive(time, inThread({ mentioned: true }));
    expect(h.assistant.runChatTurn).toHaveBeenCalledWith('thread-7', expect.anything(), expect.anything());
    expect(h.prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('Time gets the help with plain-word commands', async () => {
    const h = harness();
    await h.svc.receive(time, inbound({ command: { name: 'help', args: '' } }));
    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.helpTime' }]);
  });
});
