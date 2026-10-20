import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import type { CaptureResult } from '@knowledge/contracts';
import { ChatCapturesService, chatTranscript, type CaptureRequest } from '../src/chat/chat-captures.service.js';
import type { ChatView } from '../src/chat/adapters/chat-adapter.types.js';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';

/**
 * 💾 Save on a bot answer (issue #71, phase 2), as agent memory (#82). What is
 * pinned: an answer is the assistant pane's answer capture, with the chat as
 * its session and a server-set origin; a term the glossarist finds from what
 * was shown in the chat goes into the inbox; both are the requester's; and the
 * reply links where it went without naming a page, refusals included.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const integration = { id: 'int-1', workspaceId: WS, kind: 'telegram', name: 'Team bot', botUsername: 'kn_bot' } as never;

const thread = [
  { id: 'q1', role: 'user', content: 'How do we deploy?', sources: [] },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Through CI [S1].',
    sources: [{ documentId: 'd1', title: 'Deploy guide', cite: 'S1' }],
  },
  // Carried on in /assistant afterwards — never posted in the chat.
  { id: 'q2', role: 'user', content: 'And my private notes?', sources: [] },
  { id: 'a2', role: 'assistant', content: 'Secret.', sources: [] },
];

const proposed: CaptureResult = {
  captureId: 'cap-1',
  state: 'proposed',
  outcome: 'new-page',
  mergeRequestId: 'mr-1',
  targetDocumentId: 'doc-new',
  glossaryTermId: null,
  webUrl: 'https://kn.test/merge-requests/mr-1',
  similar: [{ documentId: 'd9', title: 'Private roadmap', score: 0.7 }],
};

describe('chatTranscript', () => {
  it('keeps only the turns shown in the chat, with citations as page links', () => {
    const text = chatTranscript(thread, new Set(['a1']));
    expect(text).toBe('Question: How do we deploy?\n\nAnswer:\nThrough CI ([Deploy guide](/documents/d1)).');
    expect(text).not.toContain('Secret');
  });
});

function harness(opts: {
  answerResult?: CaptureResult | Error;
  termResult?: CaptureResult | Error;
  suggestions?: Array<{ term: string; definition: string; aliases: string[]; existingTermId: string | null }>;
} = {}) {
  const posted: ChatView[] = [];
  const adapter = {
    render: (view: ChatView) => ({ text: '', plain: '', buttons: [], view }),
    postMessage: vi.fn(async (_c: unknown, target: { chatId: string }, msg: { view: ChatView }) => {
      posted.push(msg.view);
      return { chatId: target.chatId, messageId: `bot-${posted.length}` };
    }),
  };
  const prisma = {
    chatConversation: { findUnique: vi.fn(async () => ({ assistantThreadId: 'thread-1' })) },
    chatAnswer: { findMany: vi.fn(async () => [{ assistantMessageId: 'a1' }]) },
    assistantMessage: { findMany: vi.fn(async () => thread) },
    project: { findFirst: vi.fn(async () => ({ id: 'p-first' })) },
  };
  const settle = async (r: CaptureResult | Error | undefined, fallback: CaptureResult) => {
    if (r instanceof Error) throw r;
    return r ?? fallback;
  };
  const inbox = { fromAssistantMessage: vi.fn(async () => settle(opts.answerResult, proposed)) };
  const captures = {
    capture: vi.fn(async () =>
      settle(opts.termResult, { ...proposed, state: 'staged', outcome: 'glossary', mergeRequestId: null, targetDocumentId: null, webUrl: null }),
    ),
  };
  const glossary = {
    suggest: vi.fn(async () => ({ enabled: true, projectId: 'p-1', suggestions: opts.suggestions ?? [] })),
  };
  const svc = new ChatCapturesService(
    prisma as never,
    inbox as never,
    captures as never,
    glossary as never,
    { get: () => 'https://kn.test' } as never,
  );
  const request = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
    integration,
    adapter: adapter as never,
    ctx: { token: 'T', botUsername: 'kn_bot', serverUrl: null, actionUrl: '' },
    answerMessage: { chatId: '-100', messageId: 'bot-answer' },
    answer: { id: 'ans-1', conversationId: 'conv-1', createdAt: new Date('2026-10-14T10:00:00Z') },
    message: { id: 'a1', createdAt: new Date('2026-10-14T10:00:20Z') },
    chatTitle: 'Platform team',
    projectId: 'p-1',
    principal: { ...DEV_PRINCIPAL, userId: 'u-editor' },
    kind: 'page',
    workspaceName: 'Acme',
    ...over,
  });
  return { svc, request, inbox, captures, glossary, posted };
}

const origin = { platform: 'telegram', chatTitle: 'Platform team', from: '2026-10-14T10:00:00.000Z', to: '2026-10-14T10:00:20.000Z' };

describe('save an answer', () => {
  it('is the assistant pane’s answer capture, from the chat, with its origin, as the requester', async () => {
    const h = harness();
    await h.svc.start(h.request());
    expect(h.inbox.fromAssistantMessage).toHaveBeenCalledWith(
      'a1',
      { projectId: 'p-1' },
      expect.objectContaining({ userId: 'u-editor' }),
      { session: { client: 'chat' }, origin },
    );
    expect(h.posted).toEqual([
      {
        kind: 'notice',
        text: 'chat.capture.proposed',
        button: { label: 'chat.capture.openMergeRequest', url: 'https://kn.test/merge-requests/mr-1' },
      },
    ]);
  });

  it('a DM leaves the project to the cited pages and records no chat title', async () => {
    const h = harness();
    await h.svc.start(h.request({ projectId: null, chatTitle: null }));
    expect(h.inbox.fromAssistantMessage).toHaveBeenCalledWith('a1', {}, expect.anything(), {
      session: { client: 'chat' },
      origin: { ...origin, chatTitle: null },
    });
  });

  it('a second press is a duplicate and says so — without naming the page it matched', async () => {
    const h = harness({ answerResult: { ...proposed, state: 'duplicate', outcome: 'none', mergeRequestId: null, webUrl: 'https://kn.test/documents/d9' } });
    await h.svc.start(h.request());
    expect(h.posted[0]).toMatchObject({ text: 'chat.capture.duplicate', button: { label: 'chat.capture.openPage' } });
    expect(JSON.stringify(h.posted)).not.toContain('Private roadmap');
  });

  it.each([
    ['capture-no-citations', new BadRequestException({ statusCode: 400, reason: 'capture-no-citations' }), 'chat.capture.noPages'],
    ['capture-secret', new BadRequestException({ statusCode: 400, reason: 'capture-secret', pattern: 'aws-key' }), 'chat.capture.secret'],
    [
      'capture-rate-limited',
      new HttpException({ statusCode: 429, reason: 'capture-rate-limited' }, HttpStatus.TOO_MANY_REQUESTS),
      'chat.capture.rateLimited',
    ],
    ['an unexpected error', new Error('db down'), 'chat.capture.failed'],
  ])('a refusal for %s becomes its own reply', async (_name, err, key) => {
    const h = harness({ answerResult: err });
    await h.svc.start(h.request());
    expect(h.posted).toEqual([{ kind: 'notice', text: key }]);
  });
});

describe('save a glossary term', () => {
  const suggestions = [
    { term: 'CI', definition: 'Known already.', aliases: [], existingTermId: 'term-0' },
    { term: 'Pipeline', definition: 'The CI run that deploys.', aliases: ['pipelines'], existingTermId: null },
  ];

  it('proposes the first term the project lacks into the inbox, read from what the chat was shown', async () => {
    const h = harness({ suggestions });
    await h.svc.start(h.request({ kind: 'glossary-term' }));
    const [dto] = h.glossary.suggest.mock.calls[0] as unknown as [{ markdown: string; projectId: string }];
    expect(dto.projectId).toBe('p-1');
    expect(dto.markdown).toMatch(/^<chat tool="save_thread">/);
    expect(dto.markdown).not.toContain('Secret');
    expect(h.captures.capture).toHaveBeenCalledWith(
      {
        kind: 'glossary',
        workspaceId: WS,
        projectId: 'p-1',
        term: 'Pipeline',
        definition: 'The CI run that deploys.',
        aliases: ['pipelines'],
        session: { client: 'chat' },
      },
      expect.objectContaining({ userId: 'u-editor' }),
      { origin },
    );
    expect(h.posted[0]).toMatchObject({ text: 'chat.capture.termQueued', button: { url: 'https://kn.test/captures' } });
  });

  it('a DM proposes into the workspace’s first project', async () => {
    const h = harness({ suggestions });
    await h.svc.start(h.request({ kind: 'glossary-term', projectId: null }));
    expect(h.captures.capture).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-first' }), expect.anything(), expect.anything());
  });

  it('says so when every term is already defined', async () => {
    const h = harness({ suggestions: suggestions.slice(0, 1) });
    await h.svc.start(h.request({ kind: 'glossary-term' }));
    expect(h.captures.capture).not.toHaveBeenCalled();
    expect(h.posted).toEqual([{ kind: 'notice', text: 'chat.capture.noTerm' }]);
  });
});
